// Сборка srcdoc для iframe: в начало документа вставляется «мост» — скрипт,
// который выполняется раньше скриптов страницы и общается с плагином через postMessage.

export type Theme = "light" | "dark" | null;
export type StorageData = Record<string, string>;

export interface FrameOptions {
	theme: Theme;
	storage: StorageData;
	// В режиме "auto" iframe растёт под содержимое (вставка в заметку),
	// в режиме "fill" занимает всю вкладку и прокручивается сам.
	mode: "auto" | "fill";
}

// Сообщения из iframe в плагин.
export type FrameMessage =
	| { type: "height"; h: number }
	| { type: "storage"; data: StorageData }
	| { type: "open"; url: string };

export const MESSAGE_TAG = "__htmlVstavki";

function bridge(opts: FrameOptions): string {
	const cfg = JSON.stringify({ tag: MESSAGE_TAG, theme: opts.theme, storage: opts.storage, auto: opts.mode === "auto" })
		// Не даём содержимому хранилища закрыть тег <script> раньше времени.
		.replace(/</g, "\\u003c");
	return `<script>(function(){
var C=${cfg};
function post(m){m[C.tag]=1;try{parent.postMessage(m,"*")}catch(e){}}

// localStorage в песочнице недоступен — подменяем своим, данные уходят в плагин.
function store(obj,persist){
  var has=function(k){return Object.prototype.hasOwnProperty.call(obj,k)};
  var api={
    getItem:function(k){k=String(k);return has(k)?obj[k]:null},
    setItem:function(k,v){obj[String(k)]=String(v);persist&&post({type:"storage",data:obj})},
    removeItem:function(k){delete obj[String(k)];persist&&post({type:"storage",data:obj})},
    clear:function(){for(var k in obj)delete obj[k];persist&&post({type:"storage",data:obj})},
    key:function(i){var ks=Object.keys(obj);return i<ks.length?ks[i]:null}
  };
  return new Proxy(api,{
    get:function(t,k){if(k==="length")return Object.keys(obj).length;if(k in t)return t[k];return has(k)?obj[k]:undefined},
    set:function(t,k,v){api.setItem(k,v);return true},
    deleteProperty:function(t,k){api.removeItem(k);return true},
    has:function(t,k){return k in t||has(k)},
    ownKeys:function(){return Object.keys(obj)},
    getOwnPropertyDescriptor:function(t,k){return has(k)?{value:obj[k],enumerable:true,configurable:true,writable:true}:undefined}
  });
}
try{Object.defineProperty(window,"localStorage",{value:store(C.storage||{},true),configurable:true})}catch(e){}
try{Object.defineProperty(window,"sessionStorage",{value:store({},false),configurable:true})}catch(e){}

// Тема. Chromium не передаёт тему в prefers-color-scheme внутри iframe,
// поэтому такие условия в @media и matchMedia подменяем на «всегда да» / «всегда нет».
var theme=C.theme,orig=new WeakMap();
var YES="(min-width: 0px)",NO="(max-width: 0.001px)";
var RE=/\\(\\s*prefers-color-scheme\\s*:\\s*(dark|light)\\s*\\)/gi;
function fix(q){return theme?q.replace(RE,function(_,v){return v.toLowerCase()===theme?YES:NO}):q}
function fixRules(rules){
  for(var i=0;i<rules.length;i++){
    var r=rules[i];
    if(r.media&&r.cssRules){
      if(!orig.has(r))orig.set(r,r.media.mediaText);
      var o=orig.get(r);
      if(/prefers-color-scheme/i.test(o)){var n=fix(o);if(r.media.mediaText!==n)r.media.mediaText=n}
    }
    if(r.cssRules)fixRules(r.cssRules);
  }
}
function fixSheets(){
  for(var i=0;i<document.styleSheets.length;i++){
    try{fixRules(document.styleSheets[i].cssRules)}catch(e){}
  }
}
var mm=window.matchMedia;
window.matchMedia=function(q){return mm.call(window,fix(String(q)))};
function applyTheme(t){
  theme=t;
  var r=document.documentElement;
  if(r){if(t)r.setAttribute("data-theme",t);else r.removeAttribute("data-theme")}
  fixSheets();
}
applyTheme(theme);
new MutationObserver(function(ms){
  ms.forEach(function(m){m.addedNodes.forEach(function(n){
    if(n.nodeName==="LINK")n.addEventListener("load",fixSheets);
  })});
  fixSheets();
}).observe(document,{childList:true,subtree:true});
document.addEventListener("DOMContentLoaded",fixSheets);
addEventListener("load",fixSheets);
addEventListener("message",function(e){
  if(e.source!==parent||!e.data||!e.data[C.tag])return;
  if(e.data.type==="theme")applyTheme(e.data.theme);
});

// Внешние ссылки открываем через Obsidian, а не внутри iframe.
document.addEventListener("click",function(e){
  if(e.defaultPrevented)return;
  var a=e.target&&e.target.closest&&e.target.closest("a[href]");
  if(!a)return;
  var href=a.getAttribute("href")||"";
  if(/^(https?:|mailto:|obsidian:)/i.test(href)){e.preventDefault();post({type:"open",url:a.href})}
});

if(!C.auto)return;
// Высота: следим за содержимым и сообщаем плагину.
var last=0,bumps=0,since=Date.now();
function measure(){
  var b=document.body;if(!b)return;
  var cs=getComputedStyle(b);
  var h=Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)+(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0));
  if(h===last)return;
  // Защита от бесконечного роста, если вёрстка завязана на высоту окна.
  if(Date.now()-since>1000){since=Date.now();bumps=0}
  if(h>last&&++bumps>30)return;
  last=h;post({type:"height",h:h});
}
function watch(){
  measure();
  if(window.ResizeObserver){var ro=new ResizeObserver(measure);ro.observe(document.documentElement);document.body&&ro.observe(document.body)}
  addEventListener("load",measure);
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(measure);
  // Страховка на случай, если ResizeObserver что-то пропустил при загрузке.
  var n=0,t=setInterval(function(){measure();if(++n>=10)clearInterval(t)},500);
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",watch);else watch();
})();</script>`;
}

// Во вставке страница не должна растягиваться на «весь экран» — иначе высота растёт по кругу.
const AUTO_STYLE = `<style>html,body{min-height:0!important}html{height:auto!important}</style>`;

export function buildSrcdoc(html: string, opts: FrameOptions): string {
	let inject = bridge(opts);
	if (opts.mode === "auto") inject += AUTO_STYLE;

	const head = /<head(\s[^>]*)?>/i.exec(html);
	if (head) {
		const at = head.index + head[0].length;
		return html.slice(0, at) + inject + html.slice(at);
	}
	// Без <head> вставляем после doctype/<html>, чтобы не сломать стандартный режим.
	const lead = /^\s*(<!doctype[^>]*>)?\s*(<html(\s[^>]*)?>)?/i.exec(html);
	const at = lead ? lead[0].length : 0;
	return html.slice(0, at) + inject + html.slice(at);
}

export function isFrameMessage(data: unknown): data is FrameMessage {
	return !!data && typeof data === "object" && (data as Record<string, unknown>)[MESSAGE_TAG] === 1;
}
