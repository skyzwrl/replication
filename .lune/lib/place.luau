--[[
	Loads a Rojo-built place into Lune and runs its ModuleScripts the way Roblox would.

	Lune can deserialize a place into a DataModel but can't execute the scripts inside it, so the
	`require` returned here loads module sources with luau.load, giving each one its own `script`,
	this `require` and the engine globals. The engine members that roblox-ts output and TestEZ rely
	on are filled in below; everything else behaves as Lune's DataModel does.
]]

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local roblox = require("@lune/roblox")
local task = require("@lune/task")

type Connection = {
	Connected: boolean,
	Disconnect: (self: Connection) -> (),
}

type Event = {
	Connect: (self: Event, listener: (...any) -> ()) -> Connection,
	Once: (self: Event, listener: (...any) -> ()) -> Connection,
	Wait: (self: Event) -> ...any,
	Fire: (self: Event, ...any) -> (),
}

export type Place = {
	game: any,
	require: (module: any) -> any,
	resolve: (path: string) -> any,
	findModule: (predicate: (module: any) -> boolean) -> any?,
}

local function createEvent(): Event
	local listeners: { [Connection]: (...any) -> () } = {}
	local event = {} :: Event

	function event.Connect(_, listener)
		local connection = { Connected = true } :: Connection
		function connection.Disconnect(self)
			self.Connected = false
			listeners[self] = nil
		end
		listeners[connection] = listener
		return connection
	end

	function event.Once(self, listener)
		local connection: Connection
		connection = self:Connect(function(...)
			connection:Disconnect()
			listener(...)
		end)
		return connection
	end

	function event.Wait(self)
		local thread = coroutine.running()
		self:Once(function(...)
			task.spawn(thread, ...)
		end)
		return coroutine.yield()
	end

	function event.Fire(_, ...)
		local snapshot = {}
		for connection, listener in listeners do
			table.insert(snapshot, { connection, listener })
		end
		for _, entry in snapshot do
			if entry[1].Connected then
				task.spawn(entry[2], ...)
			end
		end
	end

	return event
end

-- Frame events tick on Lune's scheduler while anything is connected to them.
local function createFrameEvent(getArguments: (deltaTime: number, elapsed: number) -> ...any): Event
	local event = createEvent()
	local connect = event.Connect
	local connections = 0
	local ticking = false
	local elapsed = 0

	function event.Connect(self, listener)
		local connection = connect(self, listener)
		local disconnect = connection.Disconnect
		connections += 1

		function connection.Disconnect(this)
			if this.Connected then
				connections -= 1
			end
			disconnect(this)
		end

		if not ticking then
			ticking = true
			task.spawn(function()
				while connections > 0 do
					local deltaTime = task.wait()
					elapsed += deltaTime
					self:Fire(getArguments(deltaTime, elapsed))
				end
				ticking = false
			end)
		end

		return connection
	end

	return event
end

local function deltaOnly(deltaTime: number)
	return deltaTime
end

local frameEvents = {
	Heartbeat = createFrameEvent(deltaOnly),
	PreSimulation = createFrameEvent(deltaOnly),
	PostSimulation = createFrameEvent(deltaOnly),
	PreRender = createFrameEvent(deltaOnly),
	RenderStepped = createFrameEvent(deltaOnly),
	Stepped = createFrameEvent(function(deltaTime, elapsed)
		return elapsed, deltaTime
	end),
}

for name, event in frameEvents do
	roblox.implementProperty("RunService", name, function()
		return event
	end)
end

roblox.implementMethod("RunService", "IsRunning", function()
	return true
end)
roblox.implementMethod("RunService", "IsServer", function()
	return true
end)
roblox.implementMethod("RunService", "IsClient", function()
	return false
end)
roblox.implementMethod("RunService", "IsStudio", function()
	return false
end)

local playerEvents = {
	PlayerAdded = createEvent(),
	PlayerRemoving = createEvent(),
}

for name, event in playerEvents do
	roblox.implementProperty("Players", name, function()
		return event
	end)
end

roblox.implementMethod("Players", "GetPlayers", function()
	return {}
end)

local clockOffset = os.time() - os.clock()
roblox.implementMethod("Workspace", "GetServerTimeNow", function()
	return clockOffset + os.clock()
end)

-- Everything in the place already exists, so waiting is just a lookup that fails loudly.
roblox.implementMethod("Instance", "WaitForChild", function(instance, name: string)
	local child = instance:FindFirstChild(name)
	if child == nil then
		error(`Infinite yield: {instance:GetFullName()} has no child named "{name}"`, 2)
	end
	return child
end)

local function load(placePath: string): Place
	local game = roblox.deserializePlace(fs.readFile(placePath))
	local sharedGlobals = {}

	local baseEnvironment = setmetatable({
		game = game,
		workspace = game:GetService("Workspace"),
		task = task,
		tick = os.clock,
		time = os.clock,
		shared = {},
		_G = sharedGlobals,
	}, { __index = getfenv(0) })

	for name, value in roblox :: any do
		if string.match(name, "^%u") then
			baseEnvironment[name] = value
		end
	end

	local loadedModules: { [any]: { value: any } } = {}
	local loadingModules: { [any]: boolean } = {}
	local runtime: any = nil

	local function requireModule(module: any): any
		if typeof(module) ~= "Instance" or not module:IsA("ModuleScript") then
			error("Attempted to call require with invalid argument(s).", 2)
		end

		local loaded = loadedModules[module]
		if loaded then
			return loaded.value
		end
		if loadingModules[module] then
			error(`Requested module was required recursively: {module:GetFullName()}`, 2)
		end

		local source: string = module.Source

		-- roblox-ts package builds read their runtime from _G[script]. A consumer's TS.import sets
		-- that up before requiring; modules required directly (spec files) get it here instead.
		if
			runtime ~= nil
			and sharedGlobals[module] == nil
			and string.find(source, "^%-%- Compiled with roblox%-ts")
		then
			sharedGlobals[module] = runtime
		end

		local environment = setmetatable({
			script = module,
			require = requireModule,
		}, { __index = baseEnvironment })

		local chunk = luau.load(source, {
			debugName = "=" .. module:GetFullName(),
			environment = environment,
			injectGlobals = false,
		})

		loadingModules[module] = true
		local results = table.pack(pcall(chunk))
		loadingModules[module] = nil

		if not results[1] then
			error(results[2], 0)
		elseif results.n ~= 2 then
			error(`Module code did not return exactly one value: {module:GetFullName()}`, 2)
		end

		loadedModules[module] = { value = results[2] }
		return results[2]
	end

	local function resolve(path: string): any
		local current = game
		for name in string.gmatch(path, "[^%.]+") do
			local child = current:FindFirstChild(name)
			if child == nil then
				error(`{current:GetFullName()} has no child named "{name}" (resolving {path})`, 0)
			end
			current = child
		end
		return current
	end

	local function findModule(predicate: (any) -> boolean): any?
		for _, descendant in game:GetDescendants() do
			if descendant:IsA("ModuleScript") and predicate(descendant) then
				return descendant
			end
		end
		return nil
	end

	local runtimeModule = findModule(function(module)
		return module.Name == "RuntimeLib"
	end)
	if runtimeModule then
		runtime = requireModule(runtimeModule)
	end

	return {
		game = game,
		require = requireModule,
		resolve = resolve,
		findModule = findModule,
	}
end

return {
	load = load,
}
