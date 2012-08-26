
var http = require('http');
var url = require('url');
var fs = require('fs');
var path = require('path');
var api = module.exports;

api.npmURL = function npmURL(npmname, version){
	var url = "http://registry.npmjs.org/"+npmname;
	if(version) url += '/'+version;
	return url;
}

api.dereferencePackage = function dereferencePackage(packageURI, callback){
	var data = "";
	// GET http://registry.npmjs.org/<package>
	var packageURL = url.parse(packageURI);
	http.get({
		host: packageURL.hostname,
		port: packageURL.port||80,
		path: packageURL.pathname||'/'
	}, function(res) {
		if (res.statusCode==301 || res.headers.location) {
			var newurl = url.parse(res.headers.location);
			http.get({
				host: newurl.hostname,
				port: newurl.port||80,
				path: newurl.pathname||'/'
			}, arguments.callee);
		} else if (res.statusCode == 200) {
			var response = '';
			res.on('data', function (data) {
				response += data.toString();
			}).on('end', function() {
				try {
					var parsed = JSON.parse(response);
					callback(null, parsed);
				} catch(e) {
					callback(e);
				}
			});
		} else {
			callback(new Error(module + " - Bad statusCode: " + res.statusCode), null);
		}
	});
}

api.calculateRepositoryURL = function calculateRepositoryURL(parsed){
			if(parsed.repository){
				return parsed.repository.url;
			}
			var r = Array.isArray(parsed.repositories)?parsed.repositories[0]:parsed.repositories;
			if(r && r.url){
				return r.url;
			}
			return null;
}

