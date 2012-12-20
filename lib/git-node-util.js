
var child_process=require('child_process');
var semver = require('semver');
var path = require('path');

var Git = module.exports.Git = function Git(base, gitbin){
	this.base = base||'';
	this.gitbin = gitbin||['/usr/bin/env','git'];
}

Git.prototype.spawn = function spawn(arguments, options){
	if(!options) options={};
	var command = (this.gitbin instanceof Array)?this.gitbin:[this.gitbin];
	arguments = (arguments instanceof Array)?arguments:[arguments];
	if(this.base) options.cwd = path.resolve(this.base);
	var args = command.concat(arguments);
	this.log(args.join(' '));
	return child_process.spawn(args[0], args.slice(1), options);
}

Git.prototype.log = function(s){
	//console.log('\x1b[00;34m%s\x1b[00m %j', this.base, arguments);
	//console.log(arguments);
	//console.log.apply(['\x1b[00;34m%s\x1b[00m '+s, this.base].concat(Array(arguments).slice(1)));
}

Git.prototype.getPackageVersions = function getPackageVersions(base, cb){
	var p = this.spawn(['tag']);
	var data = '';
	var modules = {};
	p.stdout.on('data',function(d){
		data += d.toString();
	});
	p.on('exit', function(){
		var lines = data.split('\n');
		var versions = {};
		for(var i=0; i<lines.length; i++){
			var m = lines[i].match(/^v?([0-9\.]+(-[0-9A-Za-z-]+)?(\+[0-9A-Za-z-]+)?)$/);
			if(m) versions[m[1]]=m[0];
		}
		cb(versions);
	});
}

Git.prototype.checkoutRef = function checkoutRef(ref, cb){
	var c = this.spawn(['checkout', ref]);
	if(cb) c.on('exit', cb);
}

Git.prototype.fetchUpdates = function fetchUpdates(cb){
	var c = this.spawn(['fetch','--all']);
	c.on('close', cb);
}

function parseRefs(c, seperator, cb){
	var data = '';
	var refs = {};
	c.stdout.on('data', function(chunk){
		var start = data.length;
		data += chunk;
		var s;
		while((s=data.indexOf('\n', start))!==-1){
			var line = data.substr(0, s);
			data = data.substr(s+1);
			var p = line.split(seperator);
			refs[p[1]] = p[0];
		}
	});
	c.on('close', function(exit){
		if(exit) return cb(new Error('ls-remote returned status '+exit));
		cb(null, refs);
	});
}
module.exports.parseRefs = parseRefs;

Git.prototype.fetchRemoteRefs = function fetchUpdates(remote, cb){
	var p = this.spawn(['ls-remote',remote]);
	parseRefs(p, '\t', cb);
}

Git.prototype.getRefs = function getRefs(cb){
	var p = this.spawn(['show-ref']);
	parseRefs(p, ' ', cb);
}

function parseRefSemver(ref){
	var m = ref.match(/^refs\/tags\/v?([0-9\.]+(-[0-9A-Za-z-]+)?(\+[0-9A-Za-z-]+)?)$/);
	if(!m) return null;
	return {ref:ref, semver:m[1]};
}

Git.prototype.checkoutCompatibleVersion = function checkoutCompatibleVersion(versionRange, callback){
	this.log('checkoutCompatibleVersion %j', versionRange);
	if(!(versionRange instanceof Array)) versionRange=[versionRange];
	var self = this;
	self.getRefs(function(err, refs){
		if(!refs){ console.error('No refs for '+self.base); callback(new Error('No refs for submodule '+self.base)); return; }
		if(err){ return callback(err); }
		function filterCompatible(v){ return v&&versionRange.every(function(r){return semver.satisfies(v.semver, r)}); }
		var versions = Object.keys(refs).map(parseRefSemver).filter(filterCompatible).sort(function(a, b){ return semver.compare(a.semver, b.semver); });
		var use = versions[versions.length-1];
		if(use){
			self.checkoutRef(use.ref, function(exit){
				callback(null, use, exit);
			});
		}else{
			callback(new Error('Could not find any matching ref'), null, null);
		}
	});
}

Git.prototype.getSubmodulePackages = function getSubmodulePackages(cb){
	// git config -f .gitmodules --get-regexp '^submodule\.(.*)\.nodejs$' '^package$'
	var p = this.spawn(['config','-z','-f','.gitmodules','--get-regexp','^submodule\.(.*)\.path$','^node_modules/']);
	var data = '';
	var modules = [];
	p.stdout.on('data',function(d){
		var start = data.length;
		data += d.toString();
		var nullpos;
		while((nullpos=data.indexOf('\0', start)) !== -1){
			var entry = data.substr(0, nullpos);
			data = data.substr(nullpos+1);
			var s = entry.indexOf('\n');
			// strip out leading submodule. and trailing .nodejs
			var key = entry.substr(10, s-15);
			modules.push(key);
		}
	});
	p.on('close', function(){
		if(data.length) return cb(new Error('git config output not fully parsed'));
		cb(null, modules);
	});
}

Git.prototype.getSubmodulesTags = function getSubmodulesTags(cb){
	var moduleVersions = {};
	var waiting = 1; // A
	(new Git()).getSubmodulePackages(function(err, modules){
		['.'].concat(modules).forEach(function(module){
			var versions = moduleVersions[module] = {};
			var subgit = new Git(module);
			waiting++; // B
			subgit.getRefs(function(err, refs){
				for(var ref in refs){
					var m = ref.match(/^refs\/tags\/v?([0-9\.]+(-[0-9A-Za-z-]+)?(\+[0-9A-Za-z-]+)?)$/);
					if(!m) continue;
					versions[m[1]]={semver:m[1], ref:ref, commit:refs[ref]};
					//commitCache[refs[ref]]=module;
				}
				done(); // B
			});
		});
		done(); // A
	});
	function done(){
		if(waiting && --waiting!==0) return;
		//console.log(commitCache);
		cb(null, moduleVersions);
	}
}

Git.prototype.getnpmPackages = function getnpmPackages(value, cb){
	if(typeof value=='function'){ cb=value; value=''; }
	var p = this.spawn(['config','-z','-f','.gitmodules','--get-regexp','^submodule\.(.*)\.npm$', value]);
	var data = '';
	var packages = {};
	p.stdout.on('data',function(d){
		var start = data.length;
		data += d.toString();
		var nullpos;
		while((nullpos=data.indexOf('\0', start)) !== -1){
			var entry = data.substr(0, nullpos);
			data = data.substr(nullpos+1);
			var s = entry.indexOf('\n');
			// strip out leading submodule. and trailing .npm
			var key = entry.substr(10, s-14);
			var npmname = entry.substr(s+1);
			packages[npmname] = key;
		}
	});
	p.on('close', function(){
		if(data.length) return cb(new Error('git config output not fully parsed'));
		cb(null, packages);
	});
}

Git.prototype.getSubmoduleKey = function getSubmoduleKey(submodule, key, cb){
	var self = this;
	self.getConfigKey('.git/config', 'submodule.'+submodule+'.'+key, function(err, value){
		if(err) throw err;
		if(value) return cb(null, value);
		self.getConfigKey('.gitmodules', 'submodule.'+submodule+'.'+key, function(err, value){
			if(err) throw err;
			return cb(null, value);
		});
	});
}

Git.prototype.getConfigKey = function getConfigKey(file, key, cb){
	var p = this.spawn(['config','-z','-f',file,'--get',key]);
	var data = '';
	var value;
	p.stdout.on('data',function(d){
		var start = data.length;
		data += d.toString();
		var nullpos;
		while((nullpos=data.indexOf('\0', start)) !== -1){
			value = data.substr(0, nullpos);
			cb(null, value);
			return;
		}
	});
	p.on('close', function(){
		if(!value) cb(null, null);
	});
}

Git.prototype.setConfigKey = function getConfigKey(file, key, value, cb){
	var p = this.spawn(['config','-f',file,key,value]);
	p.on('close', function(exit){
		if(exit) cb(new Error('git-config exited with status '+exit))
		else cb(null);
	});
}


Git.prototype.add = function add(files, cb){
	files = (files instanceof Array)?files:[files];
	var p = this.spawn(['add','--force'].concat(files));
	p.on('close', function(status){
		if(status){ throw new Error('git add returned '+status); }
		cb(null);
	});
}

Git.prototype.calculateDependencies = function calculateDependencies(submodule, version, cb){
	// git config -f .gitmodules --get-regexp '^submodule\.(.*)\.nodejs$' '^package$'
	var p = this.spawn(['config','-z','-f','.gitmodules','--get-regexp','^submodule\.(.*)\.nodejs$','^package$']);
	var data = '';
	var modules = [];
	p.stdout.on('data',function(d){
		var start = data.length;
		data += d.toString();
		var nullpos;
		while((nullpos=data.indexOf('\0', start)) !== -1){
			var entry = data.substr(0, nullpos);
			data = data.substr(nullpos+1);
			var s = entry.indexOf('\n');
			// strip out leading submodule. and trailing .nodejs
			var key = entry.substr(10, s-17);
			modules.push(key);
		}
	});
	p.on('close', function(){
		if(data.length) return cb(new Error('git config output not fully parsed'));
		cb(null, modules);
	});
}
