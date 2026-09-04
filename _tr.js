process.env.OMP_NUM_THREADS='1';
const cp=require('child_process');
const w=cp.fork('./lib/ml-worker.js',{env:process.env,stdio:['ignore','inherit','inherit','ipc']});
let n=0;
w.on('message',m=>{
  if(m.ev==='ready'){ ['un câine','plajă la mare','mașină sport','mâncare','apus de soare'].forEach((q,i)=>w.send({id:i+1,op:'embedText',q})); }
  if(m.ok&&m.vec){ n++; console.log('got vec for query', m.id, '(len', Buffer.from(m.vec,'base64').length/4, ')'); if(n>=5){ w.disconnect(); process.exit(0);} }
});
setTimeout(()=>{console.log('timeout');process.exit(1)},180000);
