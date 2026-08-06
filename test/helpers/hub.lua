-- A representative protected script: roughly the shape and size of a real
-- Roblox hub, so the watermark tests measure capacity against something
-- realistic rather than a toy. Never executed — only parsed and marked.

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")
local TweenService = game:GetService("TweenService")
local HttpService = game:GetService("HttpService")
local Workspace = game:GetService("Workspace")

local LocalPlayer = Players.LocalPlayer

local Config = {
    walkSpeed = 16,
    boostSpeed = 128,
    jumpPower = 50,
    reachDistance = 2048,
    espRefresh = 30,
    farmDelay = 250,
    maxRetries = 8,
    windowWidth = 640,
    windowHeight = 480,
    accentAlpha = 200,
    notifyDuration = 4096,
    teleportCooldown = 1024,
}

local Strings = {
    title = "Project Hub",
    subtitle = "premium build",
    connected = "connection established",
    failed = "could not reach the server",
    farming = "auto farm running",
    idle = "waiting for target",
    espOn = "esp enabled",
    espOff = "esp disabled",
    noCharacter = "character not loaded",
    rejoining = "rejoining the server",
}

local State = {
    running = false,
    espEnabled = false,
    farmEnabled = false,
    targetName = "none",
    lastTeleport = 0,
    retries = 0,
    collected = 0,
}

local Connections = {}
local Highlights = {}

local function log(level, message)
    local stamp = tostring(math.floor(tick()))
    print("[" .. Strings.title .. "][" .. level .. "][" .. stamp .. "] " .. message)
end

local function notify(heading, body, duration)
    local length = duration or Config.notifyDuration
    log("notify", heading .. " :: " .. body)
    pcall(function()
        game:GetService("StarterGui"):SetCore("SendNotification", {
            Title = heading,
            Text = body,
            Duration = length / 1000,
        })
    end)
end

local function getCharacter(player)
    local target = player or LocalPlayer
    local character = target.Character
    if character == nil then return nil end
    local humanoid = character:FindFirstChildOfClass("Humanoid")
    local root = character:FindFirstChild("HumanoidRootPart")
    if humanoid == nil or root == nil then return nil end
    return character, humanoid, root
end

local function distanceBetween(first, second)
    if first == nil or second == nil then return math.huge end
    return (first.Position - second.Position).Magnitude
end

local function applySpeed(amount)
    local character, humanoid = getCharacter(LocalPlayer)
    if humanoid == nil then
        notify(Strings.title, Strings.noCharacter, 2048)
        return false
    end
    humanoid.WalkSpeed = amount
    humanoid.JumpPower = Config.jumpPower
    log("movement", "speed set to " .. tostring(amount))
    return true
end

local function teleportTo(destination)
    local now = tick() * 1000
    if now - State.lastTeleport < Config.teleportCooldown then return false end
    local character, humanoid, root = getCharacter(LocalPlayer)
    if root == nil then return false end
    root.CFrame = destination
    State.lastTeleport = now
    return true
end

local function nearestPlayer(maxDistance)
    local limit = maxDistance or Config.reachDistance
    local _, _, myRoot = getCharacter(LocalPlayer)
    if myRoot == nil then return nil end
    local closest = nil
    local closestDistance = limit
    for _, other in ipairs(Players:GetPlayers()) do
        if other ~= LocalPlayer then
            local _, _, otherRoot = getCharacter(other)
            local gap = distanceBetween(myRoot, otherRoot)
            if gap < closestDistance then
                closest = other
                closestDistance = gap
            end
        end
    end
    return closest, closestDistance
end

local function clearHighlights()
    for player, highlight in pairs(Highlights) do
        pcall(function() highlight:Destroy() end)
        Highlights[player] = nil
    end
end

local function highlightPlayer(player)
    local character = player.Character
    if character == nil then return end
    if Highlights[player] ~= nil then return end
    local box = Instance.new("Highlight")
    box.Name = "hub-esp"
    box.FillTransparency = 0.75
    box.OutlineTransparency = 0.25
    box.Adornee = character
    box.Parent = character
    Highlights[player] = box
end

local function refreshEsp()
    if State.espEnabled == false then
        clearHighlights()
        return
    end
    for _, player in ipairs(Players:GetPlayers()) do
        if player ~= LocalPlayer then highlightPlayer(player) end
    end
end

local function toggleEsp(enabled)
    State.espEnabled = enabled
    refreshEsp()
    notify(Strings.title, enabled and Strings.espOn or Strings.espOff, 1024)
end

local function collectNearby(radius)
    local reach = radius or 512
    local _, _, root = getCharacter(LocalPlayer)
    if root == nil then return 0 end
    local taken = 0
    for _, item in ipairs(Workspace:GetChildren()) do
        if item:IsA("BasePart") and item.Name == "Collectible" then
            if distanceBetween(root, item) < reach then
                item.CFrame = root.CFrame
                taken = taken + 1
            end
        end
    end
    State.collected = State.collected + taken
    return taken
end

local function farmStep()
    if State.farmEnabled == false then return end
    local target, gap = nearestPlayer(Config.reachDistance)
    if target == nil then
        State.targetName = "none"
        log("farm", Strings.idle)
        return
    end
    State.targetName = target.Name
    local _, _, targetRoot = getCharacter(target)
    if targetRoot ~= nil and gap > 16 then teleportTo(targetRoot.CFrame) end
    collectNearby(256)
end

local function encodeState()
    local payload = {
        target = State.targetName,
        collected = State.collected,
        retries = State.retries,
        speed = Config.walkSpeed,
    }
    local ok, encoded = pcall(function() return HttpService:JSONEncode(payload) end)
    if ok == false then return "{}" end
    return encoded
end

local function disconnectAll()
    for index, connection in ipairs(Connections) do
        pcall(function() connection:Disconnect() end)
        Connections[index] = nil
    end
end

local function bindInput()
    local connection = UserInputService.InputBegan:Connect(function(input, processed)
        if processed then return end
        local code = input.KeyCode
        if code == Enum.KeyCode.F then
            toggleEsp(State.espEnabled == false)
        elseif code == Enum.KeyCode.G then
            State.farmEnabled = State.farmEnabled == false
            notify(Strings.title, State.farmEnabled and Strings.farming or Strings.idle, 1024)
        elseif code == Enum.KeyCode.H then
            applySpeed(State.running and Config.walkSpeed or Config.boostSpeed)
            State.running = State.running == false
        end
    end)
    Connections[#Connections + 1] = connection
end

local function bindHeartbeat()
    local elapsed = 0
    local connection = RunService.Heartbeat:Connect(function(delta)
        elapsed = elapsed + delta * 1000
        if elapsed < Config.farmDelay then return end
        elapsed = 0
        local ok, err = pcall(farmStep)
        if ok == false then
            State.retries = State.retries + 1
            log("error", tostring(err))
            if State.retries > Config.maxRetries then
                State.farmEnabled = false
                notify(Strings.title, Strings.failed, 4096)
            end
        end
    end)
    Connections[#Connections + 1] = connection
end

local function bindRespawn()
    local connection = LocalPlayer.CharacterAdded:Connect(function(character)
        local humanoid = character:WaitForChild("Humanoid", 8)
        if humanoid == nil then return end
        task.wait(0.5)
        applySpeed(State.running and Config.boostSpeed or Config.walkSpeed)
        refreshEsp()
    end)
    Connections[#Connections + 1] = connection
end

local Hub = {}
Hub.__index = Hub

function Hub.new(options)
    local settings = options or {}
    local self = setmetatable({}, Hub)
    self.name = settings.name or Strings.title
    self.version = settings.version or "1.0.0"
    self.started = false
    return self
end

function Hub:start()
    if self.started then return false end
    self.started = true
    disconnectAll()
    bindInput()
    bindHeartbeat()
    bindRespawn()
    applySpeed(Config.walkSpeed)
    notify(self.name, Strings.connected, 2048)
    log("boot", self.name .. " " .. self.version .. " " .. encodeState())
    return true
end

function Hub:stop()
    if self.started == false then return false end
    self.started = false
    State.farmEnabled = false
    disconnectAll()
    clearHighlights()
    notify(self.name, Strings.rejoining, 1024)
    return true
end

local instance = Hub.new({ name = Strings.title, version = "2.4.1" })
instance:start()
return instance
