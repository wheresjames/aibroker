import { describe,expect,it } from "vitest";
import { safeRelativePath } from "./workspace.js";
describe("workspace paths",()=>{it("rejects traversal and protected credentials",()=>{expect(()=>safeRelativePath("../wp-config.php",["php"])).toThrow();expect(()=>safeRelativePath("plugin/.env",["php"])).toThrow();});});
