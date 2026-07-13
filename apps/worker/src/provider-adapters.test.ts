import{describe,expect,it}from"vitest";import{reviewedProviderTools}from"./provider-adapters.js";
describe("hosting adapter",()=>{it("exposes only reviewed typed mappings",()=>{expect(reviewedProviderTools()).toContain("hosting_deploy");expect(reviewedProviderTools()).not.toContain("hosting_raw_request");});});
