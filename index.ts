import { Lexer, Token, Tokenizer, Grammar, Phrase } from "sif-ts";
import TOKENS from "./tokens.json";

var sprintf = require('sprintf-js').sprintf;

var currentScope: any = null;

class JfFunction {
	private _name: string
	private _returnType: string
	private _parameters: string[]
	private _instructions: string[]
	private _exclude: boolean

	public get name(): string { return this._name }
	public get returnType(): string { return this._returnType }
	public get parameters(): string[] { return this._parameters }
	public get instructions(): string[] { return this._instructions }
	public get exclude(): boolean { return this._exclude }

	constructor(name: any, returnType: any, parameters: any, exclude: any)
	{
		this._name = name
		this._returnType = returnType
		this._parameters = parameters ?? [ ]
		this._instructions = []
		this._exclude = exclude || false;
	}

	callInstruction(): string
	{
		var parameterTypeList: any[] = [];
		for(var i = 0; i < this.parameters.length; i++) {
			parameterTypeList.push(determineLlvmType(this.parameters[i]));
		}

		var parameterList: any[] = [];
		var args = Array.prototype.slice.call(arguments);
		for(var i = 0; i < args.length; i++) {
			parameterList.push(sprintf('%s %s', determineLlvmType(args[i].type), args[i].value));
		}

		return sprintf('call %s (%s) @%s(%s)', determineLlvmType(this.returnType), parameterTypeList.join(', '), this.name, parameterList.join(', '));
	}
}

var globalContext = {
	constants: [ ],
	constantMap: { },
	functions: { },

	addConstant: function(type: any, value: any, size: any) {
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
	getConstant: function(index: any) {
		return this.constants[index];
	},
	addFunction: function(name: any, returnType: any, parameterList: any = null, exclude: any = false) {
		this.functions[name] = new JfFunction(name, returnType, parameterList, exclude);
		return name;
	},
	getFunction: function(name: any) {
		return this.functions[name];
	}
};

var Constants = {
	SPRINTF_INT: globalContext.addConstant('STRING', "%d\\00", 3),
	SPRINTFLN_INT: globalContext.addConstant('STRING', "%d\\0A\\00", 4),
	SPRINTF_FLOAT: globalContext.addConstant('STRING', "%f\\00", 3),
	SPRINTFLN_FLOAT: globalContext.addConstant('STRING', "%f\\0A\\00", 4),
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

function pushValueUp(ctx) {
	ctx.parent.type = ctx.token.name;
	ctx.parent.llvmType = determineLlvmType(ctx.token.name);
	ctx.parent.value = ctx.value;
}

function transformString(string): { value: string, length: number } {
	string = string.substring(1, string.length - 1)
	var stringLength = string.length + 1 - (string.match(/\\./g) || []).length;
	string = string
		// Actually read text will contain a \\n instead of the binary \n
		.replace('\\n', '\\0A')
		// Replace any later appended \n
		.replace('\n', '\\0A') + '\\00';
	return {
		value: string,
		length: stringLength
	}
}

let grammar = new Grammar();
grammar.add(new Phrase('PROG', ['DECLARATION_LIST']));
grammar.add(new Phrase('DECLARATION_LIST', ['DECLARATION', 'DECLARATION_LIST']));
grammar.add(new Phrase('DECLARATION_LIST', [Token.EPSILON.name]));
grammar.add(new Phrase('DECLARATION', ['FUNCTION_DECLARATION']));
grammar.add(new Phrase('FUNCTION_DECLARATION', [
	// 'ACCESS_MODIFIER_LIST', (ctx) => ctx.bag.accessModifiers = ctx.value,
	'TYPE', (ctx) => ctx.bag.returnType = ctx.value,
	'IDENTIFIER', (ctx) => {
		currentScope = ctx.value;
		globalContext.addFunction(ctx.value, ctx.bag.returnType);
	},
	'LPARAN', 'RPARAN', 'COMPOUND']));
grammar.add(new Phrase('ACCESS_MODIFIER_LIST', ['ACCESS_MODIFIER', 'ACCESS_MODIFIER_LIST']));
grammar.add(new Phrase('ACCESS_MODIFIER_LIST', [Token.EPSILON.name]));
grammar.add(new Phrase('ACCESS_MODIFIER', ['RWEXTERN', (ctx) => ctx.parent.accessModifiers.push(ctx.value) ]));
grammar.add(new Phrase('COMPOUND', ['LBRACE', 'STATEMENT_LIST', 'RBRACE']));
grammar.add(new Phrase('STATEMENT', ['ASSIGNMENT_STATEMENT']));
grammar.add(new Phrase('STATEMENT', ['IO_STATEMENT']));
grammar.add(new Phrase('STATEMENT', ['FUNCTION_DECLARATION']));
grammar.add(new Phrase('STATEMENT', ['FUNCTION_CALL']));
grammar.add(new Phrase('STATEMENT', ['RETURN_STATEMENT']));
grammar.add(new Phrase('IO_STATEMENT', ['RWPRINT', ctx => {
	ctx.bag.appendNewline = (ctx.bag.value == 'println');
}, 'LPARAN', 'VALUE', ctx => {
	if (ctx.bag.type === 'STRING') {
		var string = transformString(ctx.value.slice(0, ctx.value.length - 1) + (ctx.bag.appendNewline ? '\n' : '') + ctx.value.slice(ctx.value.length - 1));
		ctx.bag.stringLength = string.length
		var id = globalContext.addConstant('STRING', string.value, ctx.bag.stringLength);
		ctx.bag.value = id;
	}
}, 'RPARAN', ctx => {
	if (ctx.bag.type === 'STRING') {
		Array.prototype.push.apply(
			globalContext.functions[currentScope].instructions,
			sprintf(
			  	'%%cast%2$s = getelementptr [%1$d x i8], [%1$d x i8]* @%2$d, i64 0, i64 0\r\n' +
			  	globalContext.getFunction(Constants.FUNC_PRINTF).callInstruction({
			  		type: ctx.bag.type,
			  		value: ('%%cast' + ctx.bag.value)
			  	}), ctx.bag.stringLength, ctx.bag.value).split('\r\n'));
	} else if (ctx.bag.type === 'INTEGER') {
		var constantStringIndex = ctx.bag.appendNewline ? Constants.SPRINTFLN_INT : Constants.SPRINTF_INT;
		var constantString = globalContext.getConstant(constantStringIndex);
		Array.prototype.push.apply(
			globalContext.functions[currentScope].instructions,
			sprintf(
			  	'%%cast%2$s = getelementptr [%1$d x i8], [%1$d x i8]* @%2$d, i64 0, i64 0\r\n' +
			  	globalContext.getFunction(Constants.FUNC_PRINTF).callInstruction({
			  		type: 'STRING',
			  		value: '%%cast' + constantStringIndex
			  	}, {
			  		type: 'INTEGER',
			  		value: ctx.bag.value
			  	}), constantString.size, constantStringIndex, ctx.bag.value).split('\r\n'));
	}
}]));
grammar.add(new Phrase('RETURN_STATEMENT', ['RWRETURN', 'VALUE', ctx =>
	globalContext.functions[currentScope].instructions.push(sprintf('ret %s %s', ctx.bag.llvmType, ctx.bag.value))
]));
grammar.add(new Phrase('RETURN_STATEMENT', ['RWRETURN', ctx =>
	globalContext.functions[currentScope].instructions.push('ret')
]));
grammar.add(new Phrase('STATEMENT_LIST', ['STATEMENT', 'SEMICOLON', 'STATEMENT_LIST']));
grammar.add(new Phrase('STATEMENT_LIST', [Token.EPSILON.name]));
grammar.add(new Phrase('ASSIGNMENT_STATEMENT', ['TYPE', 'IDENTIFIER', 'INITIALIZER']))
grammar.add(new Phrase('INITIALIZER', [() => console.log('Pre initializer'), 'EQUAL', 'VALUE', ctx => console.log(ctx.value) ]))
grammar.add(new Phrase('INITIALIZER', [Token.EPSILON.name]))
grammar.add(new Phrase('TYPE', ['RWINT', pushValueUp]));
grammar.add(new Phrase('TYPE', ['RWFLOAT', pushValueUp]));
grammar.add(new Phrase('TYPE', ['RWCHAR', pushValueUp]));
grammar.add(new Phrase('TYPE', ['RWSTRING', pushValueUp]));
grammar.add(new Phrase('VALUE', ['INTEGER', pushValueUp]));
grammar.add(new Phrase('VALUE', ['CHARACTER', pushValueUp]));
grammar.add(new Phrase('VALUE', ['FLOAT', pushValueUp]));
grammar.add(new Phrase('VALUE', ['STRING', pushValueUp]));
grammar.add(new Phrase('PARAM_LIST', ['EXPRESSION', 'PARAM_LIST_TAIL']));
grammar.add(new Phrase('PARAM_LIST', [Token.EPSILON.name]));
grammar.add(new Phrase('PARAM_LIST_TAIL', ['COMMA', 'EXPRESSION', 'PARAM_LIST_TAIL']));
grammar.add(new Phrase('PARAM_LIST_TAIL', [Token.EPSILON.name]));
grammar.add(new Phrase('EXPRESSION', ['FUNCTION_CALL']));
grammar.add(new Phrase('EXPRESSION', ['IDENTIFIER']));
grammar.add(new Phrase('EXPRESSION', ['VALUE']));
grammar.add(new Phrase('FUNCTION_CALL', ['IDENTIFIER', 'LPARAN', 'PARAM_LIST', 'RPARAN']));
grammar.add(new Phrase('FUNCTION_CALL', ['IDENTIFIER', 'LPARAN', 'PARAM_LIST', 'RPARAN']));

let tokenizer = Tokenizer.fromJson(TOKENS);

let lexer = new Lexer('PROG', grammar, tokenizer);
lexer.parse(process.argv[2]);
for(let i = 0; i < globalContext.constants.length; i++) {
	let constant: any = globalContext.constants[i];
	if (constant.type === 'STRING') {
		console.log(sprintf('@%d = private unnamed_addr constant [%d x i8] c"%s"', i, constant.size, constant.value));
	}
}

console.log('declare i32 @puts(i8* nocapture) nounwind');
console.log('declare i32 @printf(i8*, ...)');

for(let name in globalContext.functions) {
	let method = globalContext.functions[name];
	if (method.exclude) {
		continue;
	}

	console.log('; Definition of function');
	console.log(sprintf('define %1$s @%2$s() {   ; %1$s()*', determineLlvmType(method.returnType), name));

	for (let i = 0; i < method.instructions.length; i++) {
		console.log('    ' + method.instructions[i]);
	}

	console.log(sprintf('}'));
}