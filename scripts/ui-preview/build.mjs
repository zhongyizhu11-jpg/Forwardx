import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, '.ui-preview');
await build({ configFile:false, root, plugins:[react(),tailwindcss()],
  resolve:{alias:{'@':path.join(root,'client/src'),'@shared':path.join(root,'shared')}},
  define:{'process.env.NODE_ENV':'"production"'},
  build:{outDir:out,emptyOutDir:true,lib:{entry:path.join(import.meta.dirname,'Preview.tsx'),name:'ForwardXDesign',formats:['iife'],fileName:()=> 'preview.js'}, minify:true},
});
const files=await fs.readdir(out);
const css=(await Promise.all(files.filter(x=>x.endsWith('.css')).map(x=>fs.readFile(path.join(out,x),'utf8')))).join('\n');
const js=await fs.readFile(path.join(out,'preview.js'),'utf8');
const logo=await fs.readFile(path.join(root,'client/public/logo-light.png'));
const doc=`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>window.__PREVIEW_LOGO__="data:image/png;base64,${logo.toString('base64')}";</script><script>${js.replaceAll('</script','<\\/script')}</script></body></html>`;
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ForwardX 全站设计预览</title><style>body{margin:0;background:#dde3eb;font:13px system-ui;color:#182536}header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-height:48px;padding:8px 16px;background:#fff;border-bottom:1px solid #cad3df}header span{margin-right:auto;color:#59697c}button{min-height:36px;border:1px solid #dce2ea;border-radius:6px;background:white;padding:6px 12px;color:#182536;cursor:pointer}button[aria-pressed=true]{background:#182536;color:white}main{display:flex;justify-content:center;padding:20px;min-width:0;overflow:auto}iframe{display:block;width:1280px;max-width:none;flex-shrink:0;height:920px;border:1px solid #bdc8d7;border-radius:12px;background:#f3f5f8;box-shadow:0 12px 40px #18253620}@media(max-width:700px){main{padding:8px}iframe{width:100%;height:calc(100svh - 96px)}}</style></head><body><header><strong>ForwardX · 全站设计预览</strong><span>示例数据 · 不连接生产服务</span>${[320,390,768,1280].map(w=>`<button aria-pressed="${w===1280}" onclick="document.getElementById('preview').style.width='${w}px';document.querySelectorAll('header button').forEach(b=>b.setAttribute('aria-pressed',String(b===this)))">${w}px</button>`).join('')}</header><main><iframe id="preview" title="ForwardX 交互设计预览"></iframe></main><script>document.getElementById('preview').srcdoc=${JSON.stringify(doc).replaceAll('</script','<\\/script')};</script></body></html>`;
await fs.writeFile(path.join(out,'forwardx-ui-preview.html'),html);
console.log('Preview saved:',path.join(out,'forwardx-ui-preview.html'));
