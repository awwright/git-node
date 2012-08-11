
var child_process=require('child_process');

var Git = module.exports.Git = function Git(base, gitbin){
	this.base = base;
	this.gitbin = gitbin||['/usr/bin/env','git'];
}

Git.prototype.spawn = function spawn(arguments, options){
	var command = (this.gitbin instanceof Array)?this.gitbin:[this.gitbin];
	arguments = (arguments instanceof Array)?arguments:[arguments];
	var path = this.base?['--work-tree='+this.base, '--git-dir='+this.base+'/.git']:[];
	var args = command.concat(path).concat(arguments);
	console.log('\x1b[00;34m%s\x1b[00m %s', this.base, args.join(' '));
	return child_process.spawn(args[0], args.slice(1), options);
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

Git.prototype.getSubmodulePackages = function getSubmodulePackages(cb){
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

Git.prototype.getnpmPackages = function getnpmPackages(cb){
	var p = this.spawn(['config','-z','-f','.gitmodules','--get-regexp','^submodule\.(.*)\.npm$']);
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


Git.prototype.getVersions = function getVersions(cb){
	var p = this.spawn(['tag']);
	var data = '';
	var modules = {};
	p.stdout.on('data',function(d){
		data += d.toString();
	});
	p.on('close', function(){
		var lines = data.split('\n');
		//return cb(null, lines);
		var versions = {};
		for(var i=0; i<lines.length; i++){
			var m = lines[i].match(/^v?([0-9\.]+(-[0-9A-Za-z-]+)?(\+[0-9A-Za-z-]+)?)$/);
			if(m) versions[m[1]]=m[0];
		}
		cb(null, versions);
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
