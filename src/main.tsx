import React, { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { Controller } from './engine';
import { ChromeAdapter } from './adapter';
import { DemoAdapter } from './demo';
import { LocalRepository } from './storage';
import './styles.css';

const isExtension=typeof chrome!=='undefined'&&!!chrome.runtime?.id;
const demo=!isExtension||new URLSearchParams(location.search).get('demo')==='1';
const adapter=demo?new DemoAdapter():new ChromeAdapter();
const controller=new Controller(adapter,new LocalRepository(),demo);
await controller.initialize();
if(demo){await controller.connect();await controller.scan();}
function Root(){const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot);return <App state={state} actions={controller} connection={adapter instanceof ChromeAdapter?adapter:undefined}/>;}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Root/></React.StrictMode>);
window.addEventListener('pagehide',()=>controller.pause());
