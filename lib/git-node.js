
var Git = module.exports.Git = require('./git-node-util').Git;
var npm = module.exports.npm = require('./git-node-npm');
var fs = require('fs');
var path = require('path');
var semver = require('semver');

var commands = module.exports.commands =
	{ 'help': printHelp
	, 'update': cmdUpdate
	, 'add': cmdadd
	, 'ls': cmdls
	, 'ls-repo-npmname': cmd_ls_repo_npmname
	, 'ls-npm-packages': cmd_ls_npm_packages
	, 'fetch-repo-urls': cmd_fetch_repo_urls
	, 'which': cmd_which
	};

function printHelp(){
	console.log('Usage: git node <command> [<args>]');
	console.log('');
	console.log('Some commands:');
	console.log('   update         Clone the appropriate dependencies or checkout latest compatible version');
	console.log('   add            Install a package');
	console.log('   import         Import packages to install from packages.json and node_modules');
//	console.log('   rm             Remove a submodule package with no local modifications');
	console.log('   ls             List installed submodule packages');
	console.log('   which          Check if package is installed');
}

function parseRefSemver(ref){
	var m = ref.match(/^refs\/tags\/v?([0-9\.]+(-[0-9A-Za-z-]+)?(\+[0-9A-Za-z-]+)?)$/);
	if(!m) return null;
	return {ref:ref, semver:m[1]};
}

function cmdUpdate(args){
	// First we look at all of the packages we depend on, these are specified with the
	// submodule.*.nodejs = package key, and pull compatible updates for those packages.
	// Then we look in packages.json to see if there's any npm dependencies which should be
	// listed in the root .gitmodules under submodule.*.npm but are not
	// We'll clone any missing dependencies to the root module.
	// Finally, we'll trash any unneeded Node.js packages with no local modifications.
	// TODO this function is an absolute mess, move this out to a library and provide some EventEmitter hooks
	console.log('Fetching updates...');

	update(args[0]||'.', {}, checkoutPackages);
}

function checkoutPackages(err, modulesVersions){
	if(err) throw err;
	console.log('Checking out versions');
	for(var submodule in modulesVersions) (function(submodule, modulesVersions){
		var subgit = new Git(submodule);
		var rs = modulesVersions[submodule];
		subgit.checkoutCompatibleVersion(rs, function(err, use, exit){
			if(use) console.log('\x1b[34m%s\x1b[00m %s %j %d',submodule, use.ref, rs, exit);
			else console.log('\x1b[34m%s\x1b[00m [none]',submodule);
		});
	})(submodule, modulesVersions);
}

function update(module, modulesVersions, callback){
	var relgit = new Git(module);
	// Step 2. Get list of explicit dependencies, the submodule path, the root module path, the required version and do for each one:
	relgit.getSubmodulePackages(function(err, list){
		var submodules = {};
		var waiting = 1;
		list.forEach(function(submodule){
			waiting++;
			relgit.getSubmoduleKey(submodule, 'semver', function(err, semver){
				if(err) throw err;
				submodules[submodule] = {module:module, commit:null, submodule:submodule, semver:semver||null};
				done();
			});
		});
		function done(){
			if(--waiting!==0) return;
			waiting = false;
			// Now we have the list of .gitmodules dependencies, let's search for package.json dependencies
			fs.readFile(path.join(module,'package.json'), function(err, contents){
				var packageData;
				if(contents){
					packageData = JSON.parse(contents);
				}
				if(packageData && packageData.dependencies){
					for(var n in packageData.dependencies){
						var submodule = 'node_modules/'+n;
						if(!submodules[submodule]){
							submodules[submodule] = {module:module, npmname:n, submodule:submodule, semver:packageData.dependencies[n]||'*'};
						}
					}
				}
				// Now we know all the packages that the module depends on
				haveDependenciesVersions(submodules);
			});
		}
		done();
	});

	function haveDependenciesVersions(submodules){
		// Now we're going to update/clone all the modules we depend on
		// Pick a compatible version, check it out, yeah
		var submoduleList = Object.keys(submodules);
		updateNextSubmodule(submoduleList, submodules, function(){callback(null, modulesVersions);});
	}

	function updateNextSubmodule(list, submodules, cb){
		var nextSubmodule = list.shift();
		if(nextSubmodule===undefined){ return cb();}
		updateSubmodule(submodules[nextSubmodule], function(){ updateNextSubmodule(list, submodules, cb); });
	}

	function updateSubmodule(dependency, cb){
		console.log('Dependency: %j', dependency);
		if(modulesVersions[dependency.submodule]){
			modulesVersions[dependency.submodule].push(dependency.semver);
			// We know we've already cloned/fetched this module, let's break
			return setSubmoduleData(dependency, cb);
		}
		modulesVersions[dependency.submodule] = [dependency.semver];
		// Use the symlink from module/submodule if it exists, else assume just ./submodule
		var subgit = new Git(dependency.submodule);
		subgit.fetchUpdates(function(exit, v){
			if(exit===127){
				// The submodule doesn't exist, clone it
				clonePackage(dependency, function(err){
					if(err) throw err;
					subgit.checkoutCompatibleVersion(modulesVersions[dependency.submodule], function(err, use){
						if(err) console.error(err.message||err.toString());
						//else console.error('%s: checked out %s', dependency.submodule, use.ref);
						submoduleDependency(dependency, modulesVersions, cb);
					});
				});
			}else if(exit){
				console.log('Other exit code: \x1b[00;34m%s\x1b[00m \t%s \t%s', module, dependency.submodule, exit);
				cb();
			}else{
				submoduleDependency(dependency, modulesVersions, cb);
			}
		});
	}
	function submoduleDependency(dependency, modulesVersions, cb){
		var realpath = dependency.submodule;
		// var realpath = path.join(module,dependency.submodule)
		setSubmoduleData(dependency, function(){
			update(realpath, modulesVersions, cb);
		});
	}
}

function clonePackage(dependency, callback){
	// Clone the package, since it doesn't exist.
	// First, find the clone URL
	if(dependency.clone){
		doClone(dependency.clone);
	}else if(dependency.npmname){
		npm.dereferencePackage(npm.npmURL(dependency.npmname, 'latest'), function(err, packageData){
			if(err) throw err;
			var repo = npm.calculateRepositoryURL(packageData);
			if(repo) doClone(repo.replace('git@github.com:','git://github.com/'));
			else tryGitrepos();
		});
	}else{
		var subgit = new Git(dependency.module);
		subgit.getSubmoduleKey(dependency.submodule, 'url', function(err, value){
			if(err) return callback(err);
			if(!value) return callback(new Error('No repository URL for '+dependency.module+'/'+dependency.submodule));
			doClone(value);
		});
	}
	function tryGitrepos(){
		fs.readFile('./.gitrepos', function(err, contents){
			try{
				if(err) throw err;
				var list = JSON.parse(contents);
				if(list[dependency.npmname]) return doClone(list[dependency.npmname]);
			}catch(err){
				throw new Error('No repository URL for package '+dependency.npmname+' (try specifying in .gitrepos)');
			}
		});
	}
	function doClone(cloneURL){
		////var clone = (new Git(null)).spawn(['clone','--depth','1',cloneURL,dependency.submodule], {customFds: [-1, process.stdout, process.stderr]});
		var clone = (new Git(null)).spawn(['clone',cloneURL,dependency.submodule]);
		clone.on('close', function(status){
			if(status){
				return callback(new Error('git-clone exited with status '+status));
			}
			dependency.clone = cloneURL;
			return callback(null, dependency);
		});
	}
}

function setSubmoduleData(dependency, callback){
	var git = new Git('.');
	var submodule = dependency.submodule;
	var options =
		[ {key:'submodule.'+submodule+'.path', value:submodule}
		, {key:'submodule.'+submodule+'.url', value:dependency.clone}
		, {key:'submodule.'+submodule+'.nodejs', value:'package'}
		];
	if(dependency.module=='.'){
		options.push({key:'submodule.'+submodule+'.semver', value:dependency.semver});
	}
	if(dependency.npmname){
		options.push({key:'submodule.'+submodule+'.npm', value:dependency.npmname});
	}
	function setNext(cb){
		var opt = options.shift();
		if(!opt) return cb();
		git.setConfigKey('.gitmodules', opt.key, opt.value, function(){ setNext(cb); });
	}
	setNext(function addIndex(){
		git.add(['.gitmodules', submodule], callback);
	});
}

function cmdadd(args){
	// TODO Yeah, let's move this out to a library and provide some EventEmitter hooks
	var packageSrc;
	var packageDst;
	var packageSemver='*';
	var packageType='required';
	var git = new Git('.');

	for(var i=0; i<args.length; i++){
		switch(args[i]){
			case '--required': packageType='required'; continue;
			case '--dev': packageType='dev'; continue;
			case '--optional': packageType='optional'; continue;
		}
		if(args[i][0]=='@') packageSemver=args[i].substr(1);
		else if(!packageSrc) packageSrc=args[i];
		else if(!packageDst) packageDst=args[i];
	}

	var packageData = {module:'.', submodule:'', semver:packageSemver};
	if(packageSrc.indexOf(':')===-1){
		// Source location is a package name
		packageData.npmname = packageSrc;
		packageData.submodule='node_modules/'+(packageDst||packageData.npmname);
	}else{
		// Source location is a URI
		packageData.clone = packageSrc;
		// Now, what's the submodule?
		if(packageDst){
			packageData.submodule='node_modules/'+packageDst;
		}else{
			// Gather a name from the URI, strip out leading "node-" and trailing ".js" and ".git" and characters
			var m = packageSrc.match(/\/(node-)?([^/]*)$/);
			if(!m){
				console.error("Cannot pick a module name, please provide one");
				return;
			}
			packageData.submodule = 'node_modules/'+m[2].replace(/(\.js)?(\.git)?(\/)?$/, '');
		}
	}

	console.log('Adding %s @%s to %s (%s)', packageData.clone||packageData.npmname, packageData.semver, packageData.submodule, packageType);
	clonePackage(packageData, postClone);

	function postClone(err, dependency){
		if(err) throw err;
		setSubmoduleData(dependency, done);
	}

	function done(){
		update(packageData.submodule, {}, checkoutPackages);
	}
}

function cmdUpgrade(args){
	console.log('Pretend-upgrading package x to y...');
}

function cmdimport(args){
	// First, we look for a local packages.json and see what modules are in there
	// Import these packages into .gitmodules if their entries don't already exist

	// Then we look at .gitmodules for submodule.*.npm = <name>
	// Create a submodule for them if one isn't checked out
	// Finally look and see if there exist any node_modules/*/package.json files without a submodule
	// The user will have to fix these by hand since it's probably checked into the source code
	// But we can try to get the tree ID, and look for a commit in its dedicated Git repository that has the same tree ID
	var git = new Git;
	git.getSubmodulePackages(function(err, modules){
		modules.forEach(function(v){console.log(v);});
	});
}

function cmdls(args){
	var git = new Git;
	git.getSubmodulePackages(function(err, modules){
		modules.forEach(function(v){console.log(v);});
	});
}

function cmd_ls_repo_npmname(args){
	var git = new Git;
	git.getSubmodulePackages(function(err, modules){
		modules.forEach(function(v){
			git.getSubmoduleKey(v, 'npm', function(err, npmname){
				console.log('%s %s', v, npmname);
			});
		});
	});
}

function cmd_ls_npm_packages(args){
	var git = new Git;
	git.getnpmPackages(function(err, packages){
		for(var npmname in packages){
			console.log('%s %s', packages[npmname], npmname);
		}
	});
}

function cmd_fetch_repo_urls(args){
	var git = new Git;
	git.getSubmodulePackages(function(err, modules){
		if(err) throw err;
		modules.forEach(function(v){
			git.getSubmoduleKey(v, 'npm', function(err, npmname){
				if(err) throw err;
				if(!npmname) return;
				npm.dereferencePackage(npm.npmURL(npmname, 'latest'), function(err, packageData){
					if(err) throw err;
					console.log('%s %s <%s>', v, npmname, npm.calculateRepositoryURL(packageData));
				});
			});
		});
	});
}

function cmd_which(args){
	var pkg = args[0];
	if(pkg.match(/^[a-zA-Z0-9]{40}$/)){
		isInstalledGit(pkg, function(err, v){
			console.log(v);
		});
	}else{
		isInstallednpm(pkg, function(err, v){
			console.log(v);
		});
	}
}

var submodulesTags, submodulesCommits={};
function isInstalledGit(commit, cb){
	if(submodulesTags){
		haveSubmodulesTags(submodulesTags);
	}else{
		var git = new Git('.');
		git.getSubmodulesTags(function(err, modules){
			submodulesTags = modules;
			for(var submodule in modules){
				var m = modules[submodule];
				for(var tag in m){
					submodulesCommits[m[tag].commit]=submodule;
				}
			}
			haveSubmodulesTags(modules);
		});
	}
	function haveSubmodulesTags(){
		if(submodulesCommits[commit]) console.log(submodulesCommits[commit]);
	}
}

function isInstallednpm(npmname, cb){
	var git = new Git('.');
	// Technically this argument is supposed to be a regex but this is alright, it returns the exact match among other matches
	git.getnpmPackages(npmname, function(err, value){
		if(err) return cb(err);
		if(value[npmname]) return cb(null, value[npmname]);
	});
}
