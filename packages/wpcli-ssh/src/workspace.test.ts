import { describe,expect,it } from "vitest";
import { safeRelativePath } from "./workspace.js";
describe("workspace paths",()=>{it("rejects traversal and protected credentials",()=>{expect(()=>safeRelativePath("../wp-config.php",["php"])).toThrow();expect(()=>safeRelativePath("plugin/.env",["php"])).toThrow();});it("rejects option-like path segments",()=>{expect(()=>safeRelativePath("--root=/etc",["php"])).toThrow();expect(()=>safeRelativePath("a/-x.php",["php"])).toThrow();expect(safeRelativePath("a/b.php",["php"])).toBe("a/b.php");});});
