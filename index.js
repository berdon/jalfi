var sif = require('./sif/index.js'),
	utils = require('./sif/utils.js'),
	sprintf = require('sprintf-js').sprintf,
	eyes = require('eyes');

var currentScope = null;

function JfFunction(name, returnType, parameters, exclude) {
	this._name = name;
	this._returnType = returnType;
	this._parameters = parameters || [ ];
	this._instructions = [ ];
	this._exclude = exclude || false;
}

JfFunction.prototype = {
	name: utils.getter.call(this, 'name'),
	returnType: utils.getter.call(this, 'returnType'),
	parameters: utils.getter.call(this, 'parameters'),
	instructions: utils.getter.call(this, 'instructions'),
	exclude: utils.getter.call(this, 'exclude'),
	callInstruction: function() {
		var paramaterTypeList = [];
		for(var i = 0; i < this.parameters().length; i++) {
			paramaterTypeList.push(determineLlvmType(this.parameters()[i]));
		}

		var parameterList = [];
		var args = Array.prototype.slice.call(arguments);
		for(var i = 0; i < args.length; i++) {
			parameterList.push(sprintf('%s %s', determineLlvmType(args[i].type), args[i].value));
		}

		return sprintf('call %s (%s)* @%s(%s)', determineLlvmType(this.returnType()), paramaterTypeList.join(', '), this.name(), parameterList.join(', '));
	}
}

var globalContext = {
	constants: [ ],
	constantMap: { },
	functions: { },

	addConstant: function(type, value, size) {
		if (value in this.constantMap) {
			return this.constantMap[value];
		}

		this.constants.push({
			type: type,
			value: value,
			size: size
		});
		this.constantMap[value] = this.constants.length - 1;

		return this.constants.length - 1;
	},
	getConstant: function(index) {
		return this.constants[index];
	},
	addFunction: function(name, returnType, parameterList, exclude) {
		this.functions[name] = new JfFunction(name, returnType, parameterList, exclude);
		return name;
	},
	getFunction: function(name) {
		return this.functions[name];
	}
};

var Constants = {
	SPRINTF_INT: globalContext.addConstant('STRING', "%d\\00", 3),
	SPRINTFLN_INT: globalContext.addConstant('STRING', "%d\\0A\\00", 4),
	SPRINTF_FLOAT: globalContext.addConstant('STRING', "%f\\00", 3),
	SPRINTF_FLOAT: globalContext.addConstant('STRING', "%f\\0A\\00", 4),
	FUNC_PRINTF: globalContext.addFunction('printf', 'INTEGER', ['i8*', '...'], true)
}

function determineLlvmType(value) {
	switch(value) {
		case 'int':
		case 'INTEGER':
			return 'i32';
		case 'string':
		case 'STRING':
			return 'i8*';
		default:
			return value;
	}
}

function pushValueUp() {
	this.context.parent.type = this.token.name();
	this.context.parent.llvmType = determineLlvmType(this.token.name());
	this.context.parent.value = this.value;
}

function transformString(string) {
	string = string.substring(1, string.length - 1)
	var stringLength = string.length + 1 - (string.match(/\\./g) || []).length;
	string = string.replace(/\\n/g, '\\0A') + '\\00';
	return {
		value: string,
		length: stringLength
	}
}

var grammar = new sif.Grammar();
grammar.add(new sif.Phrase('PROG', ['TYPE', function() { this.context.returnType = this.value; }, 'IDENTIFIER', function() {
	currentScope = this.value;
	globalContext.addFunction(this.value, this.context.returnType);
}, 'LPARAN', 'RPARAN', 'COMPOUND']));
grammar.add(new sif.Phrase('COMPOUND', ['LBRACE', 'STATEMENT_LIST', 'RBRACE']));
grammar.add(new sif.Phrase('STATEMENT', ['ASSIGNMENT_STATEMENT']));
grammar.add(new sif.Phrase('STATEMENT', ['IO_STATEMENT']));
grammar.add(new sif.Phrase('STATEMENT', ['FUNCTION_CALL']));
grammar.add(new sif.Phrase('STATEMENT', ['RETURN_STATEMENT']));
grammar.add(new sif.Phrase('IO_STATEMENT', ['RWPRINT', function() {
	this.context.appendNewline = (this.context.value == 'println');
}, 'LPARAN', 'VALUE', function() {
	if (this.context.type === 'STRING') {
		var string = transformString(this.value + (this.context.appendNewline ? '\n' : ''));
		this.context.stringLength = string.length;
		var id = globalContext.addConstant('STRING', string.value, this.context.stringLength);
		this.context.value = id;
	}
}, 'RPARAN', function() {
	if (this.context.type === 'STRING') {
		Array.prototype.push.apply(
			globalContext.functions[currentScope].instructions(),
			sprintf(
			  	'%%cast%2$s = getelementptr [%1$d x i8]* @%2$d, i64 0, i64 0\r\n' +
			  	globalContext.getFunction(Constants.FUNC_PRINTF).callInstruction({
			  		type: this.context.type,
			  		value: ('%%cast' + this.context.value)
			  	}), this.context.stringLength, this.context.value).split('\r\n'));
	} else if (this.context.type === 'INTEGER') {
		var constantStringIndex = this.context.appendNewline ? Constants.SPRINTFLN_INT : Constants.SPRINTF_INT;
		var constantString = globalContext.getConstant(constantStringIndex);
		Array.prototype.push.apply(
			globalContext.functions[currentScope].instructions(),
			sprintf(
			  	'%%cast%2$s = getelementptr [%1$d x i8]* @%2$d, i64 0, i64 0\r\n' +
			  	globalContext.getFunction(Constants.FUNC_PRINTF).callInstruction({
			  		type: 'STRING',
			  		value: '%%cast' + constantStringIndex
			  	}, {
			  		type: 'INTEGER',
			  		value: this.context.value
			  	}), constantString.size, constantStringIndex, this.context.value).split('\r\n'));
	}
}]));
grammar.add(new sif.Phrase('RETURN_STATEMENT', ['RWRETURN', 'VALUE', function() {
	globalContext.functions[currentScope].instructions().push(sprintf('ret %s %s', this.context.llvmType, this.context.value));
}]));
grammar.add(new sif.Phrase('RETURN_STATEMENT', ['RWRETURN', function() {
	globalContext.functions[currentScope].instructions().push('ret');
}]));
grammar.add(new sif.Phrase('STATEMENT_LIST', ['STATEMENT', 'SEMICOLON', 'STATEMENT_LIST']));
grammar.add(new sif.Phrase('STATEMENT_LIST', [sif.Token.LAMBDA.name()]));
grammar.add(new sif.Phrase('ASSIGNMENT_STATEMENT', ['TYPE', 'IDENTIFIER', 'INITIALIZER']))
grammar.add(new sif.Phrase('INITIALIZER', [function() { console.log('Pre initializer'); }, 'EQUAL', 'VALUE', function() { console.log(this.value); }]))
grammar.add(new sif.Phrase('INITIALIZER', [sif.Token.LAMBDA.name()]))
grammar.add(new sif.Phrase('TYPE', ['RWINT', pushValueUp]));
grammar.add(new sif.Phrase('TYPE', ['RWFLOAT', pushValueUp]));
grammar.add(new sif.Phrase('TYPE', ['RWCHAR', pushValueUp]));
grammar.add(new sif.Phrase('TYPE', ['RWSTRING', pushValueUp]));
grammar.add(new sif.Phrase('VALUE', ['INTEGER', pushValueUp]));
grammar.add(new sif.Phrase('VALUE', ['CHARACTER', pushValueUp]));
grammar.add(new sif.Phrase('VALUE', ['FLOAT', pushValueUp]));
grammar.add(new sif.Phrase('VALUE', ['STRING', pushValueUp]));
grammar.add(new sif.Phrase('PARAM_LIST', ['EXPRESSION', 'PARAM_LIST_TAIL']));
grammar.add(new sif.Phrase('PARAM_LIST', [sif.Token.LAMBDA.name()]));
grammar.add(new sif.Phrase('PARAM_LIST_TAIL', ['COMMA', 'EXPRESSION', 'PARAM_LIST_TAIL']));
grammar.add(new sif.Phrase('PARAM_LIST_TAIL', [sif.Token.LAMBDA.name()]));
grammar.add(new sif.Phrase('EXPRESSION', ['FUNCTION_CALL']));
grammar.add(new sif.Phrase('EXPRESSION', ['IDENTIFIER']));
grammar.add(new sif.Phrase('EXPRESSION', ['VALUE']));
grammar.add(new sif.Phrase('FUNCTION_CALL', ['IDENTIFIER', 'LPARAN', 'PARAM_LIST', 'RPARAN']));

var tokenizer = sif.Tokenizer.fromJson(require('./tokens.json'));

var lexer = new sif.Lexer('PROG', grammar, tokenizer);
lexer.parse(process.argv[2]);
for(var i = 0; i < globalContext.constants.length; i++) {
	var constant = globalContext.constants[i];
	if (constant.type === 'STRING') {
		console.log(sprintf('@%d = private unnamed_addr constant [%d x i8] c"%s"', i, constant.size, constant.value));
	}
}

console.log('declare i32 @puts(i8* nocapture) nounwind');
console.log('declare i32 @printf(i8*, ...)');

for(var name in globalContext.functions) {
	var method = globalContext.functions[name];
	if (method.exclude()) {
		continue;
	}

	console.log('; Definition of function');
	console.log(sprintf('define %1$s @%2$s() {   ; %1$s()*', determineLlvmType(method.returnType()), name));

	for (var i = 0; i < method.instructions().length; i++) {
		console.log('    ' + method.instructions()[i]);
	}

	console.log(sprintf('}'));
}