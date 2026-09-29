import path from "node:path";

export interface WorkspaceCommandOptions {
  tool: string;
  root: string;
  input: Record<string, unknown>;
  allowedExtensions: string[];
  maxFileBytes: number;
  namedCommands: Record<string, string[]>;
}

export function buildWorkspaceCommand(options: WorkspaceCommandOptions): string[] {
  if (!path.posix.isAbsolute(options.root) || options.root.includes("\0")) throw new Error("Invalid workspace root");
  const relative = typeof options.input.path === "string" ? safeRelativePath(options.input.path, options.allowedExtensions) : ".";
  const base = ["aibroker-workspace", `--root=${options.root}`, `--max-bytes=${options.maxFileBytes}`];
  switch (options.tool) {
    case "workspace_list_files": return [...base,"list",relative]; case "workspace_search_files": return [...base,"search",relative,String(options.input.content??"")];
    case "workspace_read_file": return [...base,"read",relative]; case "workspace_get_file_hash": return [...base,"hash",relative];
    case "workspace_show_diff": return [...base,"git-diff"]; case "workspace_git_status": return [...base,"git-status"];
    case "workspace_create_file": return [...base,"create",relative,encodedContent(options.input.content)];
    case "workspace_update_file": return [...base,"update",relative,requiredHash(options.input.expected_hash),encodedContent(options.input.content)];
    case "workspace_rename_file": return [...base,"rename",relative,safeRelativePath(String(options.input.content??""),options.allowedExtensions)];
    case "workspace_remove_file": return [...base,"remove",relative,requiredHash(options.input.expected_hash)];
    case "workspace_apply_patch": return [...base,"apply-patch",encodedContent(options.input.content)];
    case "workspace_run_command": { const name=String(options.input.command??""); const command=options.namedCommands[name]; if(!command)throw new Error("Unknown workspace command"); return [...base,"run",...command.map(safeCommandArgument)]; }
    case "workspace_create_branch": return [...base,"branch",branchName(options.input.content)]; case "workspace_commit": return [...base,"commit",String(options.input.content??"")];
    case "workspace_stage_deploy": return [...base,"deploy"]; case "workspace_rollback": return [...base,"rollback"];
    default: throw new Error("Unsupported workspace tool");
  }
}

export function safeRelativePath(value: string, extensions: string[]): string {
  // A segment starting with "-" could be parsed as an option (e.g. --root=/etc) by the helper.
  if (!value || value.startsWith("/") || value.includes("\0") || value.split("/").some((part)=>part===".."||part===""||part.startsWith("-"))) throw new Error("Path escapes the workspace");
  const ext=path.posix.extname(value).slice(1).toLowerCase(); if(ext&& !extensions.includes(ext)) throw new Error("File type is not allowed");
  if (["wp-config.php",".env","id_rsa","id_ed25519"].includes(path.posix.basename(value))) throw new Error("Protected path");
  return value;
}
function encodedContent(value:unknown):string{if(typeof value!=="string")throw new Error("Content is required");return Buffer.from(value,"utf8").toString("base64");}
function requiredHash(value:unknown):string{if(typeof value!=="string"||!/^[a-f0-9]{64}$/i.test(value))throw new Error("Expected SHA-256 hash is required");return value;}
function safeCommandArgument(value:string):string{if(/[\0\r\n]/.test(value))throw new Error("Invalid named command argument");return value;}
function branchName(value:unknown):string{if(typeof value!=="string"||!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(value)||value.includes(".."))throw new Error("Invalid branch name");return value;}
