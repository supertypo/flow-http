const FlowHttp = require("./lib/flow-http");

module.exports = (modules)=>{
	let {express} = modules||{};
	if(typeof express!= 'function')
		throw new Error("flow-http.FlowHttp requires express module.");
	FlowHttp.modules = modules;
	return {FlowHttp}
}