const peg	 	= require('pegjs');
const fs		= require('fs');
const util		= require('util');
const deepAssign = require('deep-assign');

const EXPRESSION 	= 'EXPRESSION';
const ATOM			= 'ATOM';
const NUMBER 		= 'NUMBER';
const VOID 			= 'VOID';
const BOOL 			= 'BOOL';
const STRUCT 		= 'STRUCT';
const OPERATOR 		= 'OPERATOR';
const FUNC  		= 'FUNC';
const STRING 		= 'STRING';
const ACTION 	 	= 'ACTION';
const ACCESSOR		= 'ACCESSOR';

const LNumber = n => ({
	type: NUMBER,
	value: n,
});

const LString = n => ({
	type: STRING,
	value: n,
});

const LBool = n => ({
	type: BOOL,
	value: n,
});

const LStruct = n => ({
	type: STRUCT,
	value: n,
});

const LFunction = fn => ({
	type: FUNC,
	value: fn,
});

const LVoid = () => ({
	type: VOID,
});

const LError = (t) => ({
	type: 'ERROR',
	value: t,
});

const log = o => {
	console.log(util.inspect(o, null, 8));
}


const ppexp = o => "("
					+ (o.left.type !== EXPRESSION ? o.left.value : ppexp(o.left))
					+ (o.operator)
					+ (o.right.type !== EXPRESSION ? o.right.value : ppexp(o.right))
					+ ")";

const h = {
	a(exp, l, r) {	
		return new Promise((res, rej) => Promise.all([ exp(l), exp(r) ]).then(result => {
			res({
				l: result[0],
				r: result[1],
			});
		}));
	}
}

const LWrap = value => {
	switch (typeof value) {

		case "string":
			return LString(value);
		case "number":
			return LNumber(value);
		case "boolean":
			return LBool(value);
		default:
			return LVoid();
	}
}

const LUnwrap = value => value.value;

const wrapFn = fn => (...args) => {
	const wargs = args.map(LUnwrap);
	try {
		const result = fn(...wargs);
		return LWrap(result);
	} catch(e) {
		return LError('Executed function returned an error: ' + e.message);
	}
};

const stdlib = {
	"?"(l, r, res, rej, exp, execute) {
		h.a(exp, l, r).then(o => {
			if (o.l.type !== VOID) {
				let context = this;
				execute(o.r.value, context).then(re => {
					res(re["__return__"] || LVoid());
				}).catch(er => {
					rej(er);
				});
			}
			res();
		}).catch(er => {
			rej(er);
		});
	},
	"print"(l, r, res, rej, exp) {
		exp(r).then(rr => {
			console.log(util.inspect(rr, null, 4));
			res();
		}).catch(er => {
			rej(er);
		});
		
	},
	"require"(l, r, res, rej, exp) {
		let temp = require(r.value.shift().value);

		const result = r.value.reduce((c, n) => {
			return c[n.value];
		}, temp);

		res(LFunction(wrapFn(result)));
	},
	"!"(l, r, res, rej, exp, execute) {
		h.a(exp, l, r).then(o => {
			if (o.l.type === FUNC) {
				let args = o.r.value.map(v => exp(v));
				Promise.all(args).then(rargs => {					
					let result = o.l.value(...rargs);
					res(result);	
				}).catch(er => {
					rej(er);
				});
			} else if (o.l.type === ACTION) {
				let context;

				if (o.r.type === ATOM) context = {};
				else context = o.r.value;

				let uvalues = [];
				for (let key in o.r.value) {
					let value = o.r.value[key];
					if (value.type === ACCESSOR) {
						uvalues.push(exp(value).then(rvalue => {
							return [ key, rvalue ];
						}));
					}
				}

				if (uvalues.length > 0) {
					Promise.all(uvalues).then(rvalues => {
						rvalues.forEach(rvalue => {
							context[rvalue[0]] = rvalue[1];
						});

						if (o.l.scope) deepAssign(context, o.l.scope);

						context['$'] = LStruct(this);

						execute(o.l.value, context).then(re => {
							res(re["__return__"] || LVoid());
						}).catch(er => {
							rej(er);
						});
					});	
				} else {
					if (o.l.scope) deepAssign(context, o.l.scope);

					context['$'] = LStruct(this);

					execute(o.l.value, context).then(re => {
						res(re["__return__"] || LVoid());
					}).catch(er => {
						rej(er);
					});
				}
			} else {
				rej('!: Cannot call operand of type ' + o.l.type + '.');
			}			
		}).catch(er => {
			rej(er);
		});
	},
	"<>"(l, r, res, rej, exp) {
		h.a(exp, l, r).then(o => {
			let promises = o.l.value.map((ll, i) => {
				let context = { "$value": ll, "$i": i };
				if (o.r.scope) deepAssign(context, this, o.r.scope);
				return execute(o.r.value, context);
			});

			return Promise.all(promises).then(result => {
				
				res();
			}).catch(rej);
		}).catch(rej);
	},
	"</"(l, r, res, rej, exp) {
		h.a(exp, l, r).then(o => {
			o.l.value.push(o.r);
			res();
		});
	},
	"return"(l, r, res, rej, exp) {
		exp(r).then(rr => {
			this['__return__'] = rr;
			res();
		});
	},
	"import"(l, r, res, rej, exp, exe, parse) {
		let file;
		if (r.type === STRING) file = r.value;
		else file = "lib/" +  r.value + ".lango";

		parse(file).then(scope => {
			this[scope["__module_name__"]] = scope["__module__"];
			res();
		}).catch(er => {
			rej(er);
		});
	},
	"module"(l, r, res, rej, exp) {
		this['__module_name__'] = r.value;
		res();
	},
	"export"(l, r, res, rej, exp) {
		if (this['__module_name__']) {
			exp(r).then(rr => {
				this['__module__'] = rr;
				res();
			}).catch(er => {
				rej(er);
			});	
		} else {
			rej('export: You need to define module first.');
		}
	},
	"new"(l, r, res, rej, exp) {
		if (r.type === ATOM) {
			if (r.value == 'Struct') res(LStruct({}));
		}
	},
	"<-"(l, r, res, rej, exp) {
		let fnre = (node, value) => {
			if (node.left.type === EXPRESSION) {
				if (node.right.type === ACCESSOR) {
					return exp(node.right).then(nr => {
						let temp = LStruct({});
						temp.value[nr.value] = value;

						return fnre(node.left, temp);
					});
				} else {
					return new Promise((ires, irej) => {
						let temp = LStruct({});
						temp.value[node.right.value] = value;

						ires(fnre(node.left, temp));
					});
				}
			} else {
				return new Promise((ires, irej) => {
					let temp = {};
					temp[node.right.value] = value;
					ires([node.left.value, temp]);
				});
			}
		};

		let scope = this;

		exp(r).then(rr => {
			fnre(l, rr).then(result => {
				if (!scope[result[0]]) scope[result[0]] = LStruct({});
				deepAssign(scope[result[0]].value, result[1]);
				res();
			});
		}).catch(er => {
			rej(er);
		});;
	},
	"obj"(l, r, res, rej, exp) {
		res(LStruct({
			test: LNumber(10),
			xyzzy: LNumber(20),
			bar: LStruct({
				dar: LNumber(30),
			}),
		}));
	},
	":"(l, r, res, rej, exp) {
		exp(l).then(ll => {
			if (r.type === ACCESSOR) {
				exp(r).then(rr => {

					if (ll.type !== STRUCT)
					return res(LVoid());

					if (rr.value in ll.value) return res(ll.value[rr.value]);
					else return res(LVoid());	
				}).catch(rej);
			} else if (r.type !== ATOM) {
				return rej(':: Right operand has to be of type Atom.');
			} else {
				if (ll.type !== STRUCT)
				return res(LVoid());

				if (r.value in ll.value) return res(ll.value[r.value]);
				else return res(LVoid());	
			}	
		}).catch(rej);
	},
	"@"(l, r, res, rej, exp) {
		h.a(exp, l, r).then(o => {
			if (o.r.type === ACTION) {
				o.r.scope = this;
				res(o.r);
			} else {
				rej('@: Right operand has to be of type Action.');
			}
		});
	},
	"<="(l, r, res, rej, exp) {
		h.a(exp, l, r).then(o => {
			if (o.l.value in o.r.value) return res(o.r.value[o.l.value]);
			else return res(LVoid());
		}).catch(rej);
	},
	"=="(l, r, res, rej, exp) {
		h.a(exp, l, r).then(o => {
			if (o.l.type !== o.r.type)
				return rej('==: Both operands has to be of the same type.');

			res(LBool(o.l.value === o.r.value));
		});
	},
	"!="(l, r, res, rej, exp) {
		h.a(exp, l, r).then(o => {
			if (o.l.type !== o.r.type)
				return rej('!=: Both operands has to be of the same type.');

			res(LBool(o.l.value !== o.r.value));
		});
	},
	"+"(l, r, res, rej, exp) {
		h.a(exp, l, r).then(o => {
			if (o.l.type !== NUMBER || o.r.type !== NUMBER)
				return rej('+: Both operands has to be of type Number.');

			res(LNumber(o.l.value + o.r.value));
		}).catch(er => {
			rej(er);
		});
	},
	"-"(l, r, res, rej, exp) {
		h.a(exp, l, r).then(o => {
			if (o.l.type !== NUMBER || o.r.type !== NUMBER)
				return rej('+: Both operands has to be of type Number.');

			res(LNumber(o.l.value - o.r.value));
		}).catch(er => {
			rej(er);
		});
	},
	"<"(l, r, res, rej, exp) {
		if (l.type !== ATOM)
			return rej('=: Left operand has to be of type Atom.');

		const scope = this;

		exp(r).then(rr => {
			scope[l.value] = rr;
			res();
		}).catch(er => {
			rej(er);
		});
	},
	"-"(l, r, res, rej, exp) {
		h.a(exp, l, r).then(o => {
			if (l.type === VOID) {
				o.r.value = -o.r.value;
				res(o.r);
			} else {
				
				res(LNumber(o.l.value - o.r.value));
			}
		}).catch(er => {
			rej(er);
		});
	}
};

const read = file => {
	return new Promise((resolve, reject) => {
		fs.readFile(file, 'utf8', (err, result) => {
			if (err) return reject(err);
			return resolve(result);
		});
	});
};

const generate = (file, text) => {
	return new Promise((resolve, reject) => {
		fs.readFile(file, 'utf8', (err, result) => {
			fs.readFile(text, 'utf8', (err, resultText) => {
				if (err) return reject(err);
				const parser = peg.generate(result);
				return resolve([parser, parser.parse(resultText)]);
			});
		});
	});
};

const parse = text => parser => new Promise((resolve, reject) => {
	fs.readFile(text, 'utf8', (err, resultText) => {
		resolve(parser.parse(resultText));
	});
});

const execute = (tree, iscope, parser) => {
	return new Promise((resolve, reject) => {
		const scope = deepAssign({}, iscope || {});
		let ptree;

		if (tree.length) ptree = tree;
		else ptree = [tree];


		const promise = ptree.reduce((p, exp) => {
			return p.then(() => new Promise((res, rej) => executeExp(stdlib, exp, res, rej, scope, parser)));
		}, Promise.resolve());

		return promise.then(results => {
			resolve(scope);	
		}).catch(er => {
			reject(er);
		});
	});
};

const executeExp = (stdlib, exp, res, rej, scope, parser) => {
	if (exp.type === EXPRESSION) {
		if (exp.operator.type !== OPERATOR){
			return rej('Operator has to be of type Operator (is ' + exp.operator.type + ').');	
		} 
		else {
			if (exp.operator.value in stdlib) {
				const internalExecute = (e) => new Promise((ires, irej) => executeExp(stdlib, e, ires, irej, scope));
				const internalParse = (e) => new Promise((ires, irej) => {

					return parse(e)(parser).then(it =>{
						return execute(it, {}, parser).then(ires);
					}).catch(err => irej(err));
				});
				stdlib[exp.operator.value].call(scope, exp.left, exp.right, res, rej, internalExecute, execute, internalParse);
			} else {
				return rej(`Operator "${exp.operator.value}" is not defined.`);
			}
		}
	} else if (exp.type === ATOM || exp.type === ACCESSOR) {
		if (exp.value in scope) {
			res(scope[exp.value]);
		} else {
			res(exp);
		}
	} else {
		res(exp);
	}
};

generate('grammar.peg', 'input.lango')
.then(res => {
	execute(res[1], {}, res[0])
	.catch(error => {
		console.error(error);
	});
});