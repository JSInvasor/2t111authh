--[==[
    2t1auth loader
    script : {{SCRIPT_NAME}}
    id     : {{SCRIPT_ID}}

    Usage (paste in your executor):
        script_key = "YOUR_KEY_HERE"
        loadstring(game:HttpGet("{{API_URL}}/loader/{{SCRIPT_ID}}.lua"))()
]==]

local API_URL   = "{{API_URL}}"
local SCRIPT_ID = "{{SCRIPT_ID}}"

local HttpService = game:GetService("HttpService")

-- 1) read the key the user set before loading this bootstrap
local key = (getgenv and getgenv().script_key) or script_key or (_G and _G.script_key)
if type(key) ~= "string" or #key == 0 then
    return warn('[2t1auth] script_key is missing. Set  script_key = "YOUR_KEY"  before loading.')
end

-- 2) collect a stable device id (HWID) and the executor name
local hwid = "unknown"
pcall(function()
    if gethwid then
        hwid = tostring(gethwid())
    else
        hwid = tostring(game:GetService("RbxAnalyticsService"):GetClientId())
    end
end)

local executor = "unknown"
pcall(function()
    if identifyexecutor then
        executor = tostring((identifyexecutor()))
    elseif getexecutorname then
        executor = tostring((getexecutorname()))
    end
end)

-- 3) find an HTTP request function (varies per executor)
local httpRequest = (syn and syn.request)
    or (http and http.request)
    or http_request
    or request
    or (fluxus and fluxus.request)
if not httpRequest then
    return warn("[2t1auth] no HTTP request function found in this executor.")
end

-- 4) anti-tamper: bail if the HTTP function has been replaced with a Lua hook
local iscc = iscclosure or is_c_closure
if iscc then
    local ok, isC = pcall(iscc, httpRequest)
    if ok and isC == false then
        return warn("[2t1auth] tampered HTTP function detected.")
    end
end

-- helper: POST json, decode json response
local function post(url, payload)
    local ok, resp = pcall(httpRequest, {
        Url = url,
        Method = "POST",
        Headers = { ["Content-Type"] = "application/json" },
        Body = HttpService:JSONEncode(payload),
    })
    if not ok or type(resp) ~= "table" or not resp.Body then
        return nil
    end
    local data
    local decoded = pcall(function() data = HttpService:JSONDecode(resp.Body) end)
    if not decoded or type(data) ~= "table" then
        return nil
    end
    return data
end

-- 5) handshake -> single-use nonce
local hs = post(API_URL .. "/api/v1/handshake", { script_id = SCRIPT_ID })
if not hs or not hs.success or not hs.nonce then
    return warn("[2t1auth] " .. tostring(hs and hs.message or "handshake failed."))
end

-- 6) authenticate with the nonce
local data = post(API_URL .. "/api/v1/auth", {
    script_id = SCRIPT_ID,
    key = key,
    hwid = hwid,
    executor = executor,
    nonce = hs.nonce,
})
if not data then
    return warn("[2t1auth] request failed.")
end
if not data.success then
    return warn("[2t1auth] " .. tostring(data.message or "authentication failed"))
end

-- 7) run the protected script (already an encrypted stub when obfuscation is on)
local fn, err = (loadstring or load)(data.script, "=2t1auth:" .. SCRIPT_ID)
if not fn then
    return warn("[2t1auth] failed to compile script: " .. tostring(err))
end
return fn()
