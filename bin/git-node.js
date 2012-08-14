#!/usr/bin/env node

var runtime = require('git-node');

// console.log(process.env);
// By the way, git --work-tree=... and whatnot sets GIT_WORK_TREE in the environment. Cool!

var args = process.argv.slice(2);

var command = args.shift()||'help';

for(var i=0; i<args.length; i++){
	switch(args[i]){
		case '--help': command='help';
	}
}

if(!runtime.commands[command]){
	console.log('Unknown command "%s"', command);
	printHelp();
	return;
}

// RUN THE COMMAND
runtime.commands[command](args);
