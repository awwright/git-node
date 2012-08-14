#!/usr/bin/env node

var Git = require('git-node/lib/git-node-util').Git;
var npm = require('git-node/lib/git-node-npm');
var fs = require('fs');
var path = require('path');

// console.log(process.env);
// By the way, git --work-tree=... and whatnot sets GIT_WORK_TREE in the environment. Cool!

var args = process.argv.slice(2);

var command = args.shift()||'help';

for(var i=0; i<args.length; i++){
	switch(args[i]){
		case '--help': command='help';
	}
}

var commands =
	{ 'help': printHelp
	, 'update': cmdUpdate
	, 'add': cmdadd
	, 'ls': cmdls
	, 'ls-repo-npmname': cmd_ls_repo_npmname
	, 'ls-npm-packages': cmd_ls_npm_packages
	, 'fetch-repo-urls': cmd_fetch_repo_urls
	, 'which': cmd_which
	};

if(!commands[command]){
	console.log('Unknown command "%s"', command);
	printHelp();
	return;
}

// RUN THE COMMAND
commands[command](args);

function printHelp(){
	console.log('Usage: git node <command> [<args>]');
	console.log('');
	console.log('Some commands:');
	console.log('   update         Clone the appropriate dependencies or checkout latest compatible version');
//	console.log('   upgrade        Pull new, version-compatible versions of submodules');
	console.log('   add            Install a package');
	console.log('   import         Import packages to install from packages.json and node_modules');
//	console.log('   rm             Remove a submodule package with no local modifications');
	console.log('   ls             List installed submodule packages');
	console.log('   which          Check if package is installed');
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

	var installnpm = true;
	var npmpackages = {};
	if(installnpm) console.log("Installing npm dependencies where they don't exist.");

	var submoduleVersions = {};
	var git;

	// For each repository, fetch packages and see if there's updates

	function checkDependencies(submodule, callback){
		var git = new Git(submodule);
		git.getSubmodulePackages(function(err, modules){
			var remaining = 1;
			modules.forEach(function(submodule){
				remaining++;
				checkPackageDependencies(submodule, function(err, v){
					done();
				});
			});
			done();
			function done(){
				if(--remaining!==0) return;
				if(installnpm) checkPackagejsonDependencies(submodule, callback);
				else callback();
			}
		});
		return git;
	}

	function checkPackagejsonDependencies(submodule, callback){
		var contents = fs.readFile(path.join(submodule,'package.json'), function(err, contents){
			if(!contents) return callback(); // no package.json to worry about here
			try{
				var packageData = JSON.parse(contents);
			}catch(e){
				throw new Error('Could not parse '+submodule+'/package.json: '+e.message);
			}
			var deps = packageData.dependencies;
			if(!deps) return callback();
			var remaining = 1;
			for(var npmname in deps){
				remaining++;
				if(!npmpackages[npmname]){
					console.log('Need npm package: %s @%s', npmname, deps[npmname]);
				}
				done();
			}
			done();
			function done(){
				if(--remaining!==0) return;
				callback();
			}
		})
	}

	(new Git('.')).getnpmPackages(function(err, packages){
		npmpackages = packages;
		git = checkDependencies('.', function(){console.log('All done!');});
	});

	function checkPackageDependencies(submodule, callback){
		if(submoduleVersions[submodule]!==undefined) return callback(null);
		submoduleVersions[submodule] = null;
		var subgit = new Git(submodule);
		git.getSubmoduleKey(submodule, 'semver', function(err, version){
			var requiredversion = version||'*';
			subgit.checkoutCompatibleVersion(requiredversion, function(err, semver){
				console.log('\x1b[00;34m%s\x1b[00m @%s', submodule, semver);
				subgit.getSubmodulePackages(function(err, modules){
					checkDependencies(submodule, callback);
				});
			});
		});
	}
}

function cmdadd(args){
	// TODO same issue here, move this out to a library and provide some EventEmitter hooks
	var packageSrc;
	var packageDst;
	var packageSemver='*';
	var packageType='required';
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

	if(packageSrc.indexOf(':')===-1){
		npm.dereferencePackage(npm.npmURL(packageSrc, 'latest'), function(err, packageData){
			if(err) throw err;
			var repo = npm.calculateRepositoryURL(packageData);
			if(!repo){
				console.log(packageData);
				throw new Error('No repository URL for pacakge '+packageSrc);
			}
			var submodule = 'node_modules/'+(packageDst||packageSrc);
			cloneFrom(packageData.name, repo);
		});
	}else{
		if(!packageDst){
			if(packageSrc.match(/^(git|https?|ssh):/)){
				// Gather a name from the URI, strip out leading "node-" and trailing ".js" and ".git" and characters
				var m = packageSrc.match(/\/(node-)?([^/]*)$/);
				if(!m){
					console.error("Cannot pick a module name, please provide one");
					return;
				}
				packageDst = m[2];
				packageDst = packageDst.replace(/(\.js)?(\.git)?(\/)?$/, '');
			}else{
				// probably not a URI
				packageDst = packageSrc;
			}
		}
		cloneFrom(packageDst, packageSrc);
	}

	function cloneFrom(modulename, cloneURL){
		console.log('Adding %s @%s to node_modules/%s as type %s', cloneURL, packageSemver, modulename, packageType);
		var submodule = 'node_modules/'+modulename;
		var clone = (new Git(null)).spawn(['clone',cloneURL,submodule], {customFds: [-1, process.stdout, process.stderr]});
		clone.on('close', function(status){
			if(status){
				throw new Error('git-clone exited with status '+status);
			}
			var git = new Git('.');
			var options =
				[ {key:'submodule.'+submodule+'.path', value:submodule}
				, {key:'submodule.'+submodule+'.url', value:cloneURL}
				, {key:'submodule.'+submodule+'.nodejs', value:'package'}
				, {key:'submodule.'+submodule+'.semver', value:packageSemver}
				, 
				];
			function setNext(cb){
				var opt = options.shift();
				if(!opt) return cb();
				git.setConfigKey('.gitmodules', opt.key, opt.value, function(){ setNext(cb); });
			}
			setNext(function addIndex(){
				git.add(['.gitmodules', submodule], function(){
					console.log('all done');
				});
			});
		});
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

function isInstalledGit(commit, cb){
	var git = new Git('.');
	git.getRefs(function(err, v){
		console.log(v);
	});
}

function isInstallednpm(npmname, cb){
	var git = new Git('.');
	// Technically this argument is supposed to be a regex but this is alright, it returns the exact match among other matches
	git.getnpmPackages(npmname, function(err, value){
		if(err) return cb(err);
		if(value[npmname]) return cb(null, value[npmname]);
	});
}
