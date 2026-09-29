import { connectorFetch, validateConnectorTarget } from "@aibroker/core";

export interface ProviderRequest { tool:string;baseUrl:string;token:string;input:Record<string,unknown>;idempotencyKey?:string;allowPrivateTargets:boolean; }
export interface ProviderResult { providerReference?:string;status:string;result:unknown; }
export interface HostingAdapterDefinition { id:string;apiVersion:string;credentialKind:"hosting_provider_token";tools:string[];redactedFields:string[];supports(baseUrl:string):boolean; }
type Mapping={method:"GET"|"POST";path:string};
const mappings:Record<string,Mapping>={hosting_deploy:{method:"POST",path:"/deployments"},hosting_rollback:{method:"POST",path:"/rollbacks"},hosting_clone_environment:{method:"POST",path:"/environments/clone"},hosting_set_domain:{method:"POST",path:"/domains"},hosting_manage_certificate:{method:"POST",path:"/certificates"},hosting_flush_cache:{method:"POST",path:"/cache/flush"},hosting_create_snapshot:{method:"POST",path:"/snapshots"},hosting_get_runtime:{method:"GET",path:"/runtime"},hosting_get_deployment_logs:{method:"GET",path:"/deployment-logs"}};

export async function executeReviewedProvider(request:ProviderRequest):Promise<ProviderResult>{
  const mapping=mappings[request.tool];if(!mapping)throw new Error("Provider tool is not reviewed");
  const url=new URL(mapping.path,request.baseUrl);if(mapping.method==="GET")for(const[key,value]of Object.entries(request.input)){if(["server_id","reason","idempotency_key"].includes(key)||value==null)continue;if(typeof value==="string"||typeof value==="number"||typeof value==="boolean")url.searchParams.set(key,String(value));}const target=url.toString();await validateConnectorTarget(target,{allowPrivateTargets:request.allowPrivateTargets});
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),120000);let response:Response;let text:string;try{response=await connectorFetch(target,{method:mapping.method,redirect:"error",signal:controller.signal,headers:{authorization:`Bearer ${request.token}`,"content-type":"application/json",...(request.idempotencyKey?{"idempotency-key":request.idempotencyKey}:{})},...(mapping.method==="POST"?{body:JSON.stringify(request.input)}:{})},{allowPrivateTargets:request.allowPrivateTargets});text=await readBounded(response,1024*1024);}finally{clearTimeout(timer);}let result:unknown;try{result=text?JSON.parse(text):{};}catch{result={message:text};}
  if(!response.ok)throw Object.assign(new Error(`Provider returned HTTP ${response.status}`),{code:"provider_error",status:response.status});
  const body=result as{ id?:unknown;status?:unknown};return{...(body&&typeof body.id==="string"?{providerReference:body.id}:{}),status:body&&typeof body.status==="string"?body.status:"succeeded",result};
}

export function reviewedProviderTools():string[]{return Object.keys(mappings);}
export const GENERIC_HOSTING_ADAPTER:HostingAdapterDefinition={id:"aibroker_v1",apiVersion:"v1",credentialKind:"hosting_provider_token",tools:reviewedProviderTools(),redactedFields:["token","authorization","secret","password"],supports:(baseUrl)=>{try{return new URL(baseUrl).protocol==="https:";}catch{return false;}}};
async function readBounded(response:Response,max:number):Promise<string>{const declared=Number(response.headers.get("content-length"));if(Number.isFinite(declared)&&declared>max)throw new Error("Provider response exceeded limit");if(!response.body)return"";const reader=response.body.getReader();const chunks:Buffer[]=[];let total=0;for(;;){const{done,value}=await reader.read();if(done)break;if(value){total+=value.length;if(total>max){await reader.cancel();throw new Error("Provider response exceeded limit");}chunks.push(Buffer.from(value));}}return Buffer.concat(chunks).toString("utf8");}
