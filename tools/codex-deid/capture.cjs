// one-off: log what Codex sends to a custom provider, forward nothing
const http=require('http'),fs=require('fs');
http.createServer((q,s)=>{const c=[];q.on('data',d=>c.push(d));q.on('end',()=>{const b=Buffer.concat(c);fs.appendFileSync('capture.log',JSON.stringify({m:q.method,u:q.url,h:q.headers,len:b.length})+'\n');fs.writeFileSync('capture-body-'+Date.now()+'.bin',b);s.writeHead(500);s.end('{}');});}).on('upgrade',(q,sock)=>{fs.appendFileSync('capture.log','UPGRADE '+q.url+'\n');sock.destroy();}).listen(3014,'127.0.0.1');
