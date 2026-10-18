import {xPageRuntime} from './x-api';
// Static bundled injection: helpers remain in this closure. There is no eval, remote code, or message relay.
(window as typeof window & {__reciprocalXRuntimeV2?:typeof xPageRuntime}).__reciprocalXRuntimeV2=xPageRuntime;
