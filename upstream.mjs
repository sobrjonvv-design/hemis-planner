/* Optional Node.js 18+ transport for Windows TLS compatibility.
   One request on stdin, one response on stdout, both base64 UTF-8 JSON.
   No listener, files, cookies, credentials, or response bodies are logged. */
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

const DEFAULT_HOSTS=['student.tift.uz','xmn.tuit.uz','student.tdtu.uz','talaba.tsue.uz','hstudent.nuu.uz','student.hemis.uz'];
function fail(error,code='UPSTREAM_NETWORK',status=502){return {ok:false,status,code,error};}
function publicAddress(ip){
  if(isIP(ip)===4){const b=ip.split('.').map(Number);return !(b[0]===0||b[0]===10||b[0]===127||b[0]>=224||b[0]===169&&b[1]===254||b[0]===172&&b[1]>=16&&b[1]<=31||b[0]===192&&b[1]===168||b[0]===100&&b[1]>=64&&b[1]<=127);}
  const value=ip.toLowerCase();if(value.startsWith('::ffff:'))return publicAddress(value.slice(7));
  return isIP(value)===6&&!['::','::1'].includes(value)&&!/^(?:f[cd]|fe[89ab]|ff)/.test(value);
}
async function upstream(input){
  if(typeof fetch!=='function')return fail('For this optional transport, use Node.js 18 or newer.','UPSTREAM_RUNTIME');
  const payload=input?.request;
  let target;try{target=new URL(payload?.target);}catch{return fail('Invalid HEMIS address.','TARGET_INVALID',400);}
  const hosts=new Set([...DEFAULT_HOSTS,...(Array.isArray(input.allowedHosts)?input.allowedHosts:[])]);
  if(target.protocol!=='https:'||target.username||target.password||target.port||target.hash||!hosts.has(target.hostname))return fail('Portal not allowed.','TARGET_FORBIDDEN',403);
  if(!/^\/rest\/v1\/(auth\/login|education\/(schedule|attendance|subjects))$/.test(target.pathname)||target.search&&!/^\?page=\d{1,4}$/.test(target.search))return fail('Endpoint not allowed.','ENDPOINT_FORBIDDEN',403);
  const addresses=await lookup(target.hostname,{all:true});
  if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))return fail('Private network destinations are blocked.','TARGET_FORBIDDEN',403);
  const login=target.pathname.endsWith('/auth/login');
  const method=String(payload.method||'GET').toUpperCase();
  if(method!==(login?'POST':'GET'))return fail('Method not allowed.','METHOD_NOT_ALLOWED',405);
  const headers={Accept:'application/json'};let body;
  if(login){
    if(typeof payload.body?.login!=='string'||!payload.body.login.trim()||payload.body.login.length>160||typeof payload.body.password!=='string'||!payload.body.password||payload.body.password.length>256)return fail('Check login and password.','LOGIN_FIELDS_INVALID',400);
    headers['Content-Type']='application/json';body=JSON.stringify({login:payload.body.login.trim(),password:payload.body.password});
  }else{
    const token=typeof payload.token==='string'?payload.token.replace(/^Bearer\s+/i,'').trim():'';
    if(!token||token.length>8192||/[\r\n]/.test(token))return fail('A Bearer token is required.','TOKEN_REQUIRED',401);
    headers.Authorization='Bearer '+token;
  }
  const response=await fetch(target,{method,headers,body,redirect:'manual',signal:AbortSignal.timeout(18000)});
  if(response.status>=300&&response.status<400)return fail('HEMIS redirected the request. Check the API address.','UPSTREAM_REDIRECT');
  if(Number(response.headers.get('content-length'))>5*1024*1024)return fail('HEMIS response is too large.','TOO_LARGE',413);
  const chunks=[];let size=0;
  for await(const chunk of response.body||[]){size+=chunk.length;if(size>5*1024*1024)return fail('HEMIS response is too large.','TOO_LARGE',413);chunks.push(chunk);}
  const content=Buffer.concat(chunks).toString('utf8');
  try{return {ok:response.ok,status:response.status,data:JSON.parse(content)};}catch{}
  if(/^\s*(?:<\?xml[^>]*>\s*)?<response(?:\s|>)/i.test(content)&&! /<!DOCTYPE|<!ENTITY/i.test(content)&&/<\/response\s*>\s*$/.test(content))return {ok:response.ok,status:response.status,format:'xml',data:content};
  return fail(`Мост получил ответ HEMIS, но это страница вместо данных API (HTTP ${response.status}).`,'UPSTREAM_NOT_JSON',response.status);
}
let result;
try{
  let encoded='';for await(const chunk of process.stdin){encoded+=chunk.toString('ascii');if(encoded.length>100000)throw Error('Input limit');}
  const input=JSON.parse(Buffer.from(encoded.trim(),'base64').toString('utf8'));
  result=await upstream(input);
}catch(error){
  const code=error.cause?.code||error.code||'';
  result=error.name==='TimeoutError'?fail('HEMIS did not reply in time.','UPSTREAM_TIMEOUT'):/CERT|TLS|SSL/.test(code)?fail('A trusted HTTPS connection to HEMIS could not be established.','UPSTREAM_TLS'):fail('Could not resolve or reach the HEMIS portal.','UPSTREAM_NETWORK');
}
process.stdout.write(Buffer.from(JSON.stringify(result),'utf8').toString('base64'));
