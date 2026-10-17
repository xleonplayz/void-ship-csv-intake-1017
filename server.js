import http from 'node:http';
import {RELEASE, REVIEW_CENTS} from './policy.js';
import {HTML, CLIENT} from './ui.js';

const MAX_BODY = 524288;
class InputError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function multipart(buffer, contentType) {
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match || (match[1] || match[2]).length > 100) throw new InputError(400, 'Multipart boundary required');
  const boundary = '--' + (match[1] || match[2]);
  const text = buffer.toString('utf8');
  if (!text.startsWith(boundary+'\r\n') || !text.endsWith(boundary+'--\r\n') && !text.endsWith(boundary+'--')) throw new InputError(400, 'Incomplete multipart body');
  const parts = text.split('\r\n'+boundary);
  let file;
  for (let i=0; i<parts.length-1; i++) {
    const part = i===0 ? parts[i].slice(boundary.length+2) : parts[i].slice(2);
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) throw new InputError(400, 'Malformed multipart part');
    const headers = part.slice(0,split);
    if (!/content-disposition: form-data;[^\r\n]*name="manifest"(?:;|\r|$)/i.test(headers)) continue;
    if (file !== undefined) throw new InputError(400, 'Exactly one manifest required');
    if (!/filename="[^"\r\n]+"/i.test(headers)) throw new InputError(400, 'CSV file required');
    file = part.slice(split+4);
  }
  if (file === undefined) throw new InputError(400, 'Manifest file missing');
  return file;
}
function csvRows(text) {
  if (text.charCodeAt(0)===0xfeff) text=text.slice(1);
  const rows=[];let row=[],value='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quoted) {
      if(c==='"') { if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;} }
      else value+=c;
    } else if(c===',') {row.push(value);value='';closed=false;}
    else if(c==='\r'||c==='\n') {
      if(c==='\r'&&text[i+1]==='\n')i++;
      row.push(value);rows.push(row);row=[];value='';closed=false;
    } else if(c==='"'&&value===''&&!closed)quoted=true;
    else { if(closed||c==='"')throw new InputError(422,'Malformed CSV quoting');value+=c; }
  }
  if(quoted)throw new InputError(422,'Unclosed CSV quote');
  if(value!==''||row.length||closed){row.push(value);rows.push(row);}
  return rows;
}
function analyse(csv, bytes) {
  const rows=csvRows(csv);
  if(!rows.length||rows[0].join(',')!=='sku,name,quantity,unit_price') throw new InputError(422,'Expected columns: sku,name,quantity,unit_price');
  if(rows.length<2)throw new InputError(422,'At least one data row required');
  if(rows.length>5001)throw new InputError(422,'At most 5000 rows allowed');
  const seen=new Set();let totalCents=0,totalUnits=0,reviewCount=0;
  const lines=rows.slice(1).map((row,index)=>{
    if(row.length!==4)throw new InputError(422,'Row '+(index+2)+': expected four columns');
    const [sku,name,q,p]=row;
    if(!/^[A-Z0-9-]{1,32}$/.test(sku)||seen.has(sku))throw new InputError(422,'Row '+(index+2)+': invalid or duplicate SKU');
    if(!name||name.length>200)throw new InputError(422,'Row '+(index+2)+': invalid name');
    if(!/^[1-9][0-9]{0,4}$/.test(q)||!/^(0|[1-9][0-9]{0,5})\.[0-9]{2}$/.test(p))throw new InputError(422,'Row '+(index+2)+': invalid quantity or price');
    seen.add(sku);
    const quantity=Number(q),unitCents=Number(p.replace('.','')),amountCents=quantity*unitCents;
    const review=amountCents>=REVIEW_CENTS;
    totalUnits+=quantity;totalCents+=amountCents;if(review)reviewCount++;
    return {sku,name,quantity,unitCents,amountCents,review};
  });
  return {release:RELEASE,reviewThresholdCents:REVIEW_CENTS,receivedBytes:bytes,rowCount:lines.length,totalUnits,totalCents,reviewCount,lines};
}
function escaped(value) {
  let text=String(value);
  if(/^[=+@-]/.test(text))text="'"+text;
  return /[",\r\n]/.test(text)?'"'+text.replaceAll('"','""')+'"':text;
}
function exportCsv(result) {
  const rows=[['sku','name','quantity','unit_price','amount','review']];
  for(const line of result.lines)rows.push([line.sku,line.name,line.quantity,(line.unitCents/100).toFixed(2),(line.amountCents/100).toFixed(2),line.review?'yes':'no']);
  return '\ufeff'+rows.map(row=>row.map(escaped).join(',')).join('\r\n')+'\r\n';
}
function send(res,status,body,type='application/json; charset=utf-8',extra={}) {
  const value=typeof body==='string'?body:JSON.stringify(body);
  res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-manifest-release':String(RELEASE),...extra});res.end(value);
}
const server=http.createServer(async(req,res)=>{
  const path=req.url.split('?')[0];
  try {
    if(req.method==='GET'&&path==='/')return send(res,200,HTML(RELEASE),'text/html; charset=utf-8');
    if(req.method==='GET'&&path==='/client.js')return send(res,200,CLIENT,'text/javascript; charset=utf-8');
    if(req.method==='GET'&&path==='/health')return send(res,200,{ok:true,release:RELEASE,reviewThresholdCents:REVIEW_CENTS,maxBody:MAX_BODY});
    if(path!=='/api/import'&&path!=='/api/export')return send(res,404,{error:'Not found'});
    if(req.method!=='POST')return send(res,405,{error:'POST required'},undefined,{allow:'POST'});
    if(!String(req.headers['content-type']||'').toLowerCase().startsWith('multipart/form-data'))return send(res,415,{error:'Use multipart/form-data'});
    let bytes=0;const chunks=[];
    await new Promise((resolve,reject)=>{
      req.on('data',chunk=>{bytes+=chunk.length;if(bytes<=MAX_BODY)chunks.push(chunk);});
      req.on('end',resolve);req.on('error',reject);
    });
    if(bytes>MAX_BODY)throw new InputError(413,'Upload exceeds 512 KiB');
    const result=analyse(multipart(Buffer.concat(chunks),req.headers['content-type']),bytes);
    console.info('manifest_request '+JSON.stringify({path,bytes,rows:result.rowCount,release:RELEASE}));
    if(path==='/api/export')return send(res,200,exportCsv(result),'text/csv; charset=utf-8',{'content-disposition':'attachment; filename="manifest-reviewed.csv"'});
    return send(res,200,result);
  }catch(error){console.error('manifest_error '+JSON.stringify({path,status:error.status||500,message:error.message}));return send(res,error.status||500,{error:error.status?error.message:'Import failed',release:RELEASE});}
});
server.listen(Number(process.env.PORT||3280),'0.0.0.0',()=>console.info('manifest_ready '+JSON.stringify({release:RELEASE})));
