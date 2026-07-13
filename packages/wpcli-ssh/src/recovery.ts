export type RecoveryTool="backup_create"|"backup_list"|"backup_get"|"backup_verify"|"backup_restore"|"backup_delete"|"deployment_snapshot_create"|"deployment_snapshot_restore"|"database_check"|"database_optimize"|"database_export"|"database_import"|"database_list_tables"|"database_search_replace_preview"|"database_search_replace"|"database_restore_snapshot";
export function buildRecoveryCommand(tool:RecoveryTool,input:Record<string,unknown>,paths:{wpCliPath?:string;wordpressPath?:string|null}={}):string[]{
  const args=["bash","/usr/local/lib/aibroker/recovery.sh",tool,`--wp-cli=${paths.wpCliPath??"wp"}`,...(paths.wordpressPath?[`--wordpress-path=${paths.wordpressPath}`]:[])];
  for(const key of ["id","kind","name","search","replace","backup_id","retention_days","network"]){const value=input[key];if(value===undefined||value===null)continue;if(typeof value!=="string"&&typeof value!=="number"&&typeof value!=="boolean")throw new Error(`Invalid ${key}`);const text=String(value);if(text.length>1000||/[\0\r\n]/.test(text))throw new Error(`Invalid ${key}`);args.push(`--${key.replaceAll("_","-")}=${text}`);}
  return args;
}
