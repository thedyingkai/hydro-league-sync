export function multischoolPage(liveUrl) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>三校联调 · ICPC Live</title><style>
*{box-sizing:border-box}body{margin:0;background:#0d1421;color:#e8edf7;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif}
header,main{max-width:1440px;margin:auto;padding:20px 24px}header{display:flex;justify-content:space-between;align-items:center;gap:16px}
h1{font-size:24px;line-height:1.3;margin:4px 0}p{margin:2px 0;color:#a8b6cc}.tag{color:#70e2bd;font-size:12px;letter-spacing:2px}
a{color:#91bdff;text-decoration:none}a:hover{text-decoration:underline}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.card{padding:16px 18px;border:1px solid #29364d;background:#151f30;border-radius:12px}.top{display:flex;justify-content:space-between;gap:10px;font-weight:600}
.state{font-size:12px;color:#90a1b8}.ONLINE{color:#6ae5af}.OFFLINE{color:#ff9b8c}.DELAYED{color:#ffd98c}.numbers{display:flex;gap:25px;margin-top:12px}.numbers span{display:block;color:#98a9c1;font-size:12px}.numbers b{font-size:23px;font-variant-numeric:tabular-nums}
.detail{font-size:12px;margin-top:10px;color:#9eb0ca}.phase{margin:16px 0;padding:12px 16px;border-left:3px solid #70e2bd;background:#142a2c;display:flex;justify-content:space-between;gap:15px}
.screen{width:100%;aspect-ratio:16/9;overflow:hidden;border-radius:12px;background:#080d16;border:1px solid #29364d;position:relative}
iframe{border:0;width:1920px;height:1080px;transform-origin:top left;position:absolute;left:0;top:0}.foot{display:flex;justify-content:space-between;gap:20px;margin:12px 0;font-size:12px;color:#a8b6cc}
.logs{font:12px/1.7 ui-monospace,monospace;white-space:pre-wrap;color:#aabbd3;background:#101a2a;padding:14px 18px;border-radius:10px;max-height:160px;overflow:auto}
@media(max-width:700px){header,main{padding:14px}.cards{grid-template-columns:1fr}.numbers{margin-top:5px}.numbers b{font-size:18px}.phase,.foot{display:block}header{align-items:flex-start}h1{font-size:21px}}
</style><header><div><div class="tag">LOCAL REHEARSAL · 模拟数据</div><h1>三校同步，一张直播榜</h1><p>三个独立学校进程 → HMAC 上报 → Hub 统一计分 → ICPC Live</p></div><a href="${liveUrl}/admin" target="_blank" rel="noopener">打开 Live 控制台 ↗</a></header>
<main><div class="cards" id="schools"></div><div class="phase"><strong id="phase">正在连接三校数据…</strong><span id="elapsed"></span></div>
<div class="screen" id="screen"><iframe title="ICPC Live 实时榜单" id="live" src="${liveUrl}/overlay?noStatus&teamMediaAudio=false"></iframe></div>
<div class="foot"><span>每校 3 队 · 共 6 题 · 每校独立密钥、序列与本地待发送队列</span><a href="${liveUrl}/overlay?noStatus&teamMediaAudio=false" target="_blank" rel="noopener">单独打开直播画面 ↗</a></div>
<p style="font-size:12px;margin-bottom:10px">每轮 80 秒：20 秒时乙校断联，38 秒时恢复补传，48 秒时丙校重判。保持启动终端开启，Ctrl+C 停止。此演示模拟学校提交源，不启动真实 Hydro 判题机。</p>
<div class="logs" id="logs">等待启动…</div></main><script>
const cards=new Map();
for(const [id,name] of [['school-a','甲校'],['school-b','乙校'],['school-c','丙校']]){
 const card=document.createElement('div');card.className='card';
 card.innerHTML='<div class="top"><span>'+name+'</span><span class="state">连接中</span></div><div class="numbers"><div><b class="records">0</b><span>本地提交</span></div><div><b class="queued">0</b><span>等待上报</span></div><div><b class="acked">0</b><span>已确认版本</span></div></div><div class="detail">独立学校进程</div>';
 document.getElementById('schools').append(card);cards.set(id,card);
}
function resize(){document.getElementById('live').style.transform='scale('+(document.getElementById('screen').clientWidth/1920)+')'}
new ResizeObserver(resize).observe(document.getElementById('screen'));resize();
async function update(){try{
 const response=await fetch('/demo/status',{cache:'no-store'});if(!response.ok)throw Error('连接中断');const state=await response.json();
 for(const item of state.schools){const card=cards.get(item.siteId);if(!card)continue;const s=item.simulator||{},h=item.hub||{};
 const status=card.querySelector('.state');status.textContent=h.status||'连接中';status.className='state '+(h.status||'');
 card.querySelector('.records').textContent=s.records||0;card.querySelector('.queued').textContent=s.queued||0;card.querySelector('.acked').textContent=s.acked||0;
 card.querySelector('.detail').textContent='上报通道 '+(s.online===false?'已断开':'已连接')+' · 中心水位 '+(h.hub_high_watermark||0)+' · '+(h.watermark_consistent?'已对齐':'同步中');
 }
 document.getElementById('phase').textContent=state.phaseLabel;
 document.getElementById('elapsed').textContent='运行 '+state.elapsedSeconds+' 秒 · 本轮 '+state.cycleSeconds+'/80 秒';
 document.getElementById('logs').textContent=state.logs.slice(-6).map(x=>x.time+'  '+x.message).join('\n');
}catch{document.getElementById('phase').textContent='本地演示已停止，重新运行启动命令即可';}}
update();setInterval(update,1000);
</script></html>`;
}
