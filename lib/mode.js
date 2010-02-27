var sys = require('sys'),
    fs = require('fs'),
    path = require('path'),
    git = require('git'),
    cli = require('cli'),
    sh = require('sh'),
    CallQueue = require('queue').CallQueue;

var repr = sys.inspect;

// ---------------------------------------------------------------------------
// public module properties

var _baseDir;
exports.__defineGetter__('baseDir', function(){
  return _baseDir;
});
exports.__defineSetter__('baseDir', function(v){
  _baseDir = v;
  // update git.dir
  git.dir = _baseDir;
});
exports.baseDir = path.dirname(__dirname);

exports.__defineGetter__('indexDir', function(){
  return path.join(exports.baseDir, 'index');
});
exports.__defineGetter__('installedDir', function(){
  return path.join(exports.baseDir, 'installed');
});
exports.__defineGetter__('activeDir', function(){
  return path.join(exports.baseDir, 'active');
});

exports.defaultBranch = 'master';

// ---------------------------------------------------------------------------
// internal helpers

const WORDSPLIT_RE = /\W+/;

function fnnoext(fn) {
  var a = path.basename(fn);
  var p = a.lastIndexOf('.');
  if (p === -1 || p === 0) return fn;
  return fn.substr(0, fn.length-(a.length-p));
}

function rmrf(fn, cb) {
  return sys.exec("rm -rf '"+fn.replace("'","\\'")+"'", cb);
}

// ---------------------------------------------------------------------------
// string matchers

function SubstringMatch(string, caseSensitive) {
  this.string = string;
  this.caseSensitive = caseSensitive;
}
SubstringMatch.prototype.test = function(fn){
  if (!this.caseSensitive) fn = fn.toLowerCase();
  return fnnoext(fn).indexOf(this.string) !== -1;
}
SubstringMatch.prototype.toString = function(){
  return this.string;
}

function PrefixOrWordMatch(string, caseSensitive) {
  this.string = string;
  this.caseSensitive = caseSensitive;
}
PrefixOrWordMatch.prototype.test = function(fn){
  if (!this.caseSensitive) fn = fn.toLowerCase();
  if (fn.indexOf(this.string) === 0) return true;
  fn = fnnoext(fn);
  var string = this.string;
  var words = fn.split(WORDSPLIT_RE);
  if (words.some(function(word){ return word === string; }))
    return true;
  if (words.pop().indexOf(this.string) === 0) return true;
}
PrefixOrWordMatch.prototype.toString = SubstringMatch.prototype.toString;

// ---------------------------------------------------------------------------
// public API

function Module(id) {
  process.EventEmitter.call(this);
  this.id = id;
  this.info = {};
  this.categories = [];
  this.depends = [];
  this.config = {};
}
sys.inherits(Module, process.EventEmitter);
exports.Module = Module;

Module.prototype.__defineGetter__('repoBranch', function(){
  return this.config.repoBranch || this.info.repoBranch || exports.defaultBranch;
});

Module.prototype.__defineGetter__('shortId', function(){
  var p = this.id.lastIndexOf('/');
  return p === -1 ? this.id : this.id.substr(p+1);
});

Module.prototype.__defineGetter__('installId', function(){
  var tag = this.repoBranch;
  if (this.config.repoRevision)
    tag += '-'+this.config.repoRevision.replace('/','-');
  return path.join(this.id, tag);
});

Module.prototype.__defineGetter__('activeId', function(){
  var p = this.shortId;
  if (this.config.repoRevision)
    p += '@'+this.config.repoRevision.replace('/','-');
  else if (this.usesExplicitBranch)
    p += '@'+this.repoBranch;
  return p;
});

Module.prototype.__defineGetter__('installDir', function(){
  return path.join(exports.installedDir, this.installId);
});

Module.prototype.__defineGetter__('activePath', function(){
  return path.join(exports.activeDir, this.activeId);
});

Module.prototype.__defineGetter__('usesExplicitBranch', function(){
  if (this.info.repoBranch) return this.repoBranch !== this.info.repoBranch;
  else return this.repoBranch !== 'master';
});

Module.prototype.toString = function(detailed){
  return this.shortId+'@'+this.repoBranch;
}

Module.prototype.description = function(detailed){
  var version = (this.info.version ? ' ('+this.info.version+')' : '');
  var name = this.id;
  if (cli.isColorTerminal) {
    var R = '\033[0;0m';
    name = '\033[1;36m'+name+R;
    if (version.length)
      version = ' \033[1;34m'+version.trimLeft()+R;
  }
  if (detailed) {
    var s = [
      name+version
    ];
    if (this.categories.length)
      s.push('  Categories:  '+this.categories.join(', '));
    if (this.depends.length)
      s.push('  Depends:     '+this.depends.join(', '));
    if (this.info.url)
      s.push('  Website:     '+this.info.url);
    if (this.info.description) {
      var label = '  Description: ';
      var value = this.info.description.linewrap(label.length);
      s.push(label+value);
    }
    return s.join('\n');
  }
  else {
    return name + version+
      (this.info.description ? ' — '+this.info.description : '');
  }
}

Module.prototype.applyIndexContent = function(content, filename){
  var wrapper = "(function (exports, info, require, module, "+
    "__filename, __dirname) { " + content + "\n});";
  wrapper = process.compile(wrapper, filename);
  wrapper.apply(this.info, [this.info, this.info, require, this, 
      filename || '(string)',
      filename ? path.dirname(filename) : undefined]);
  
  var n = this.info;
  
  if (n.description) {
    var s = n.description;
    s = s.replace(/^[\s\._-]+|[\s\._-]+$/g, '');
    if (s.length === 0)
      delete n.description;
    n.description = s+'.';
  }

  if (n.categories) {
    if (Array.isArray(n.categories))
      this.categories = this.categories.concat(n.categories);
    else
      this.categories.push(n.categories);
  }

  if (n.depends) {
    if (Array.isArray(n.depends))
      this.depends = this.depends.concat(n.depends);
    else
      this.depends.push(n.depends);
  }

  if (n.github) {
    this.info.repo = 'git://github.com/'+n.github+'.git';
    this.info.url = 'http://github.com/'+n.github;
  }
  
  this.emit('info');
}

Module.prototype.loadFromIndex = function(filename, callback){
  var self = this;
  fs.readFile(filename, function(err, content){
    if (err) {
      if (callback) callback(err);
      return;
    }
    try {
      self.applyIndexContent(content, filename);
      if (callback) callback(null, self);
    }
    catch (e) {
      var p = e.stack.split('\n');
      p.splice(1,0,['    in '+filename]);
      e.stack = p.join('\n');
      if (callback) callback(e);
    }
  })
}

// uninstall( [options], [callback(error, wasInstalled)] )
Module.prototype.uninstall = function(options, callback) {
  var self = this;
  fs.stat(this.config.installDir, function(notfound) {
    if (notfound) {
      if (callback) callback(null, false);
      return;
    }
    self.emit('will-uninstall');
    sh.rm(self.config.installDir, 'rf', function(err){
      if (!err) self.emit('did-uninstall');
      if (callback) callback(err, true);
    });
  });
}

Module.prototype._checkoutGit = function(options, callback) {
  this.emit('will-checkout');
  var self = this;
  var execopt = {worktree:this.config.installDir, outbuf:false, errfwd:true};
  var args = ['checkout', '--force'];
  if (!options.verbose) args.push('--quiet');
  args.push(self.config.repoRevision || exports.defaultBranch);
  git.exec(args, execopt, function(err, so, se){
    if (err && err.message && (
      (err.message.indexOf('HEAD is now at ') === 0) || 
      (err.message.indexOf('Already on  ') === 0)
    )) {
      err = null;
    }
    if (!err) self.emit('did-checkout');
    if (callback) callback(err);
  });
}

// todo: move most code into git module
Module.prototype._fetchGit = function(options, callback) {
  function fixargs(args) {
    if (options.verbose && cli.isTerminal) args.push('--verbose');
    else args.push('--quiet');
    return args;
  }
  var self = this;
  fs.stat(this.config.installDir, function(err, stats) {
    if (!err && stats && stats.isDirectory()) {
      // found, so do a pull instead
      self.emit('will-fetch', 'patch');
      var args = ['pull', '--no-rebase'];
      args = fixargs(args);
      args.push('origin');
      args.push(self.repoBranch);
      var exopt = {worktree:self.config.installDir, outbuf:false, errfwd:true};
      git.exec(args, exopt, function(err, so, se){
        self.emit('did-fetch');
        self._checkoutGit(options, callback);
      });
    }
    else {
      // not found -- do a clone
      // todo: find any other local clone of the same repo and pass the path of
      //       that repo as --reference <directory>.
      self.emit('will-fetch', 'complete');
      var args = ['clone', self.config.repoURI, '--recursive'];
      args = fixargs(args);
      // --recursive = After the clone is created, initialize all submodules.
      if (self.config.repoRevision)
        args.push('--no-checkout');
      else if (self.repoBranch && self.repoBranch !== 'master')
        args = args.concat(['--branch', self.repoBranch]);
      args.push(self.config.installDir);
      var execopt = {worktree:false, outbuf:false, errfwd:true};
      git.exec(args, execopt, function(err, so, se){
        if (self.config.repoRevision) {
          self._checkoutGit(options, function(err) {
            if (!err) self.emit('did-fetch');
            if (callback) callback(err);
          });
        }
        else {
          self.emit('did-fetch');
          if (callback) callback(err);
        }
      });
    }
  });
}

Module.prototype.fetch = function(options, callback) {
  // fetch // todo: add support for other kinds of repositories
  if (!this.config.repoURI)
    return callback(new Error('No sources for module '+this));
  // todo: check what kind of repo it is and default to git
  return this._fetchGit(options, callback);
}

Module.prototype.configure = function(options, callback) {
  var self = this;
  var jobs = new CallQueue(this, false, callback);
  
  // run custom configure method
  if (typeof this.info.configure === 'function') {
    jobs.push(function(jobdone){
      var jobs_push = jobs.push;
      try {
        // if configure calls jobs.push, make sure those jobs are
        // executed directly after jobdone is invoked.
        jobs.push = jobs.pushPrioritized;
        self.info.configure.call(this, options, jobs2, jobdone);
      }
      finally {
        jobs.push = jobs_push;
      }
    });
  }
  
  // any jobs?
  if (jobs.queue.length) {
    this.emit('will-configure');
    jobs.push(function(cl){ this.emit('did-configure'); cl(); });
    jobs.start();
  }
  else {
    callback();
  }
}

Module.prototype.build = function(options, callback) {
  // todo: build
  // todo: if (needed) ..
  // note: respect options.force
  return callback();
  this.emit('will-build');
  this.emit('did-build');
}

Module.prototype.activate = function(options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  if (!this.config.isSetup)
    options = this._prepareConfig(options);
  if (!this.config.product) {
    var e = new Error('Nothing to activate (no product configured)');
    if (callback) callback(e);
    return e;
  }
  var self = this,
      dstpath = this.activePath;
  
  var mklink = function(){
    self.emit('will-activate');
    // first, create the directories if needed
    fs.mkdirs(path.dirname(dstpath), function(err, pathsCreated){
      if (err) {
        if (callback) callback(err);
        return;
      }
      var link = path.relativize(dstpath, self.installDir);
      fs.symlink(link, dstpath, function(err){
        if (!err) {
          self.emit('did-activate');
          if (callback) callback();
        }
        else if (callback) {
          if (err.stack) {
            err.stack = err.stack.substr(0,7)+
              'fs.symlink('+repr(link)+', '+repr(dstpath)+'): '
              + err.stack.substr(7);
          }
        }
      });
    });
  }
  
  fs.lstat(dstpath, function(err, stats){
    if (err) {
      if (err.errno === process.ENOENT) {
        mklink();
      }
      else {
        // lstat failed
        if (callback) callback(err);
      }
    }
    else if (stats.isSymbolicLink()) {
      fs.readlink(dstpath, function(err, link) {
        if (err) {
          if (callback) callback(err);
          return;
        }
        var resolved = path.normalize(path.join(dstpath, link));
        if (resolved === self.installDir) {
          // already active
          // The "true" arg means the module was already active
          self.emit('will-activate', true);
          self.emit('did-activate', true);
          if (callback) callback(null, true);
        }
        else {
          rmrf(dstpath, function(err){
            if (!err) mklink();
            else if (callback) callback(err);
          });
        }
      });
    }
    else {
      // something there, but not a symlink
      if (callback) {
        callback(new Error('target '+repr(dstpath)+
          ' exists but is not a link'));
      }
    }
  });
}

Module.prototype._prepareConfig = function(options) {
  if (typeof options !== 'object') options = {};
  
  // short-hands
  var conf = this.config, info = this.info;
  conf.isSetup = true;
  
  // setup this.config
  if (!conf.installDir || options.installDir)
    conf.installDir = options.installDir || this.installDir;
  
  if (!conf.product)
    conf.product = info.product || conf.installDir;
  
  if (!conf.repoURI || options.repoURI)
    conf.repoURI = options.repoURI || info.repo;
  
  if (!conf.repoBranch || options.repoBranch)
    conf.repoBranch = options.repoBranch || info.repoBranch || exports.defaultBranch;
  
  return options;
}

Module.prototype.install = function(options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  if (!this.config.isSetup)
    options = this._prepareConfig(options);
  
  // queue jobs
  var jobs = new CallQueue(this, false, callback);
  
  //if (options.force)
  //  jobs.push(function(cl){ this.clean(options, cl); });
  jobs.push(function(cl){ this.fetch(options, cl); });
  jobs.push(function(cl){ this.configure(options, cl); });
  jobs.push(function(cl){ this.build(options, cl); });
  jobs.push(function(cl){ this.activate(options, cl); });
  
  // start installation process
  jobs.start();
}

// Module functions

// Find modules
// find(String, Object, Function) -> EventEmitter
// @emits "module" (Module)
Module.find = function(query, options, callback) {
  if (!query) {
    throw new Error('missing query argument');
  }
  else if (typeof query !== 'string' && !(query instanceof RegExp)) {
    throw new Error('query argument must be a string (not '+
      (typeof query)+')');
  }
  // Normalize query to an object responding to test(String)
  if (query instanceof RegExp) {
    options.regexp = true;
  }
  else if (options.regexp || query.charAt(0) === '/') {
    // match as a regexp
    if (query.charAt(0) === '/') {
      var p = query.lastIndexOf('/');
      if (p === -1) {
        throw new Error(
          'Malformed regular expression -- missing ending "/" character')
      }
      query = new RegExp(query.substr(1,p-1), query.substr(p+1));
    }
    else {
      query = new RegExp(query, options.case_sensitive ? '' : 'i');
    }
  }
  else if (options.substr) {
    // match substrings
    query = new SubstringMatch(query, options.case_sensitive);
  }
  else {
    // match words and prefixes
    query = new PrefixOrWordMatch(query, options.case_sensitive);
  }
  
  // find matches
  var modules = [];
  var self = this, dir = exports.indexDir;
  var cl = fs.find(dir, query);
  cl.addCallback(function(err){
    callback(err, modules);
  });
  cl.addListener('file', function(relpath, abspath){
    if (path.extname(relpath) !== '.js')
      return;
    var module = new Module(fnnoext(relpath));
    cl.incr();
    module.loadFromIndex(path.join(dir, relpath), function(err) {
      if (cl.closed) return; // unrolling
      else if (err) return cl.close(err); // abort
      cl.emit('module', module);
      modules.push(module);
      cl.decr();
    });
  });
  
  return cl;
}
