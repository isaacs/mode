var sys = require('sys'),
    mode = require('mode'),
    CallQueue = require('queue').CallQueue,
    cli = require('cli');

function moduleInstaller(self, module, options) {
  // setup some logging
  if (!options.quiet) {
    module.addListener('will-clean', function(){
      self.log('  Cleaning '+this);
    }).addListener('will-fetch', function(type){
      self.log('  '+(type === 'patch' ? 'Updating' : 'Fetching')+
        ' '+this+' from '+this.info.repo);
    }).addListener('will-configure', function(){
      self.log('  Configuring '+this);
    }).addListener('will-build', function(){
      self.log('  Building '+this);
    }).addListener('will-activate', function(wasAlreadyActive){
      if (wasAlreadyActive)
        self.log('  Keeping already active '+this);
      else
        self.log('  Activating '+this);
    });
    
    if (options.verbose) {
      module.addListener('did-configure', function(){
        self.log('  => '+options.installFiles);
      })
    }
  }
  
  return function(closure){
    if (!self.options.quiet) {
      if (cli.isColorTerminal) {
        var R = '\033[0;0m';
        self.log('\033[1;33m'+'Installing '+module+R);
      }
      else {
        self.log('Installing '+module);
      }
    }
    var opt = {};
    process.mixin(opt, self.options, options);
    module.install(opt, function(err){
      if (!err && !opt.quiet) {
        var msg = 'Installed '+module;
        if (cli.isColorTerminal)
          msg = '\033[1;32m'+msg+'\033[0;0m';
        self.log(msg);
      }
      closure(err);
    });
  }
}

// ---------------------------------------------------------------------------
// Subcommand

exports.desc = 'Install modules.';
exports.options = [
  'Usage: .. install [options] <module> ..',
  'Options:',

  ['force',       'Force fetching and building even when not neccessary.'],

  ['repoURI',     'Override the repository defined by the index. Warning: '+
                  'this might give you unexpected results.',
                  {type: 'string', short: 'u', long: 'repo-uri'}],

  ['repoBranch',  'Fetch a specific branch, other than the recommended '+
                  'default, from the module repository. Only applies to '+
                  'modules managed by revision control systems like git.',
                  {type: 'string', short: 'b', long: 'repo-branch'}],

  ['repoRevision','Checkout and use a specific revision (or any refspec for '+
                  'git repositories). Might need to be used in combination '+
                  'with --repo-branch depending on repository type and '+
                  'configuration.',
                  {type: 'string', short: 'r', long: 'repo-rev'}],

  ['installDir',  'Override installation location (Note: this is not the '+
                  '"active" location, but where a module version is '+
                  '"unpacked").',
                  {type: 'string', short: 'i', long: 'install-path'}],

  ['case-sensitive',
                  'Make query case-sensitive. Default for --regexp query '+
                  'without the "i" flag when --regexp.',
                  {short: 'c'}],
]
exports.main = function(args, options) {
  var self = this,
      query = this.mkModuleQuery(args),
      queue = new CallQueue(this, function(err){ if (err) self.exit(err); });

  mode.Module.find(query, options, function(err, modules){
    if (err) self.exit(err);
    //sys.p(modules.map(function(x){return x.id}))
    // todo: resolve module dependencies and queue in order
    modules.forEach(function(module){
      queue.push(moduleInstaller(self, module, options));
    });
  });
}
