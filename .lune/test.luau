--[[
	Runs the TestEZ specs in a Rojo-built place without Roblox Studio.

		lune run test <place.rbxl> <path.to.root> [<path.to.root> ...]
]]

local process = require("@lune/process")
local task = require("@lune/task")

local Place = require("./lib/place")

local placePath = process.args[1]
local rootPaths = { table.unpack(process.args, 2) }

if placePath == nil or #rootPaths == 0 then
	print("usage: lune run test <place.rbxl> <path.to.root> [<path.to.root> ...]")
	process.exit(2)
end

local place = Place.load(placePath)

local testEZModule = place.findModule(function(module)
	return module.Name == "src" and module.Parent ~= nil and module.Parent.Name == "testez"
end)
if testEZModule == nil then
	error("TestEZ was not found in the place; is @rbxts/testez installed and mapped?", 0)
end

local TestEZ = place.require(testEZModule)
local TestEnum = TestEZ.TestEnum

local roots = {}
for _, path in rootPaths do
	table.insert(roots, place.resolve(path))
end

local function printNode(node: any, depth: number)
	local indent = string.rep("  ", depth)

	if node.planNode.type == TestEnum.NodeType.It then
		local status = node.status
		local label = if status == TestEnum.TestStatus.Success
			then "ok  "
			elseif status == TestEnum.TestStatus.Skipped then "skip"
			else "FAIL"
		print(`{indent}{label}  {node.planNode.phrase}`)
		return
	end

	print(`{indent}{node.planNode.phrase}`)
	for _, child in node.children do
		printNode(child, depth + 1)
	end
end

local reporter = {
	report = function(results: any)
		for _, child in results.children do
			printNode(child, 0)
		end

		if #results.errors > 0 then
			print("\nFailures:\n")
			for _, message in results.errors do
				print(message)
				print()
			end
		end

		print(`{results.successCount} passed, {results.failureCount} failed, {results.skippedCount} skipped`)
	end,
}

local timeout = tonumber(process.env.TEST_TIMEOUT) or 300

-- a spec that yields and is never resumed would otherwise let Lune exit cleanly with nothing reported
task.delay(timeout, function()
	print(`\ntest run did not finish within {timeout}s, a spec yielded and was never resumed`)
	process.exit(1)
end)

-- specs run on a spawned thread because Lune can't resume its main thread after a raw coroutine.yield
task.spawn(function()
	local ok, results = pcall(TestEZ.TestBootstrap.run, TestEZ.TestBootstrap, roots, reporter)
	if not ok then
		print(results)
		process.exit(1)
	end
	-- exit explicitly, a spec may leave a frame event connected which would keep Lune running
	process.exit(if results.failureCount > 0 or #results.errors > 0 then 1 else 0)
end)
