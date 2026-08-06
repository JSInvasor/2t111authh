--[==[
    2t1auth loader
    script : {{SCRIPT_NAME}}
    id     : {{SCRIPT_ID}}

    Usage (paste in your executor):
        script_key = "YOUR_KEY_HERE"
        loadstring(game:HttpGet("{{API_URL}}/loader/{{SCRIPT_ID}}.lua"))()

    Flow:
        handshake  -> single-use nonce + session salt
        proof      -> HMAC-SHA256(salt, nonce|script|key|hwid|executor)
        auth       -> encrypted payload, keyed by SHA256(salt|nonce|script|key|hwid)
    The payload never carries its own key, so a captured response is inert
    outside the session that requested it.
]==]

local API_URL   = "{{API_URL}}"
local SCRIPT_ID = "{{SCRIPT_ID}}"

{{SHA256}}

local HttpService = game:GetService("HttpService")

-- 1) read the key the user set before loading this bootstrap
local key = (getgenv and getgenv().script_key) or script_key or (_G and _G.script_key)
if type(key) ~= "string" or #key == 0 then
    return warn('[2t1auth] script_key is missing. Set  script_key = "YOUR_KEY"  before loading.')
end

-- 2) collect a stable device id (HWID) and the executor name.
--    Both are normalised here to the charset the server accepts, so the string
--    that gets hashed is exactly the string that goes on the wire.
local hwid = ""
pcall(function()
    if gethwid then
        hwid = tostring(gethwid())
    else
        hwid = tostring(game:GetService("RbxAnalyticsService"):GetClientId())
    end
end)
hwid = string.sub(string.gsub(hwid, "[^%w%.%-_:]", ""), 1, 128)

local executor = "unknown"
pcall(function()
    if identifyexecutor then
        executor = tostring((identifyexecutor()))
    elseif getexecutorname then
        executor = tostring((getexecutorname()))
    end
end)
executor = string.sub(string.gsub(executor, "[^%w%.%-_ ]", ""), 1, 64)
if #executor == 0 then executor = "unknown" end

-- 3) find an HTTP request function (varies per executor)
local httpRequest = (syn and syn.request)
    or (http and http.request)
    or http_request
    or request
    or (fluxus and fluxus.request)
if not httpRequest then
    return warn("[2t1auth] no HTTP request function found in this executor.")
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

-- Tell the server a client-side check tripped. Best effort — a failed report
-- never changes what we do next.
local function report(reason)
    pcall(post, API_URL .. "/api/v1/report", {
        script_id = SCRIPT_ID,
        key = key,
        executor = executor,
        hwid = hwid,
        reason = reason,
    })
end

-- Report and refuse to continue.
local function bail(reason, message)
    report(reason)
    return warn("[2t1auth] " .. (message or "tamper detected"))
end

-- 4) anti-tamper. Every check is conservative: it only fires when the executor
--    can tell us for certain, so a missing API is never treated as tampering.
--
--    Two tiers on purpose. `iscclosure` is the executor answering outright that
--    a primitive we hand the payload to is a Lua closure — that is a hook, and
--    we stop. The rest are weaker signals that some executors trip legitimately
--    (a few genuinely wrap these in Lua), so they are reported for the dashboard
--    and we keep going rather than locking a paying user out.
local isCClosure = iscclosure or is_c_closure
local loadChunk = loadstring or load

local function hooked(fn)
    if not isCClosure or type(fn) ~= "function" then return false end
    local ok, isC = pcall(isCClosure, fn)
    return ok and isC == false
end

-- Caught a hooked primitive. Whether that ends the run or is only put on record
-- is a server setting (TAMPER_HARD_STOP), because the trade is uneven: a hook
-- wrapped in newcclosure reads as a C closure and walks past this check either
-- way, so stopping buys little against anyone serious while costing every user
-- whose executor wraps these functions for its own reasons.
local HARD_STOP = {{HARD_STOP}}

if hooked(httpRequest) then
    report("hook:http")
    if HARD_STOP then return warn("[2t1auth] tampered HTTP function detected.") end
end
if hooked(loadChunk) then
    report("hook:loadstring")
    if HARD_STOP then return warn("[2t1auth] tampered loadstring detected.") end
end

-- Advisory signals.
local jsonEncode, jsonDecode
pcall(function()
    jsonEncode, jsonDecode = HttpService.JSONEncode, HttpService.JSONDecode
end)
if hooked(jsonEncode) or hooked(jsonDecode) then report("hook:json") end

-- Cross-check with the debug library: a genuine executor primitive reports "[C]"
-- as its source, a Lua-level replacement reports a real chunk name.
if debug and debug.info then
    local ok, src = pcall(debug.info, httpRequest, "s")
    if ok and type(src) == "string" and #src > 0 and src ~= "[C]" then
        report("hook:http_source")
    end
end

-- 5) handshake -> single-use nonce + session salt
local hs = post(API_URL .. "/api/v1/handshake", { script_id = SCRIPT_ID })
if not hs or not hs.success or not hs.nonce then
    return warn("[2t1auth] " .. tostring(hs and hs.message or "handshake failed."))
end
local nonce = tostring(hs.nonce)
local salt = tostring(hs.salt or "")

-- 6) prove we hold this session's salt, over the exact request we're sending.
--    The salt itself never leaves the client, so the proof can't be forged from
--    a captured auth request alone.
local proof = ""
pcall(function()
    proof = hmac256hex(salt, table.concat({ nonce, SCRIPT_ID, key, hwid, executor }, "|"))
end)

local data = post(API_URL .. "/api/v1/auth", {
    script_id = SCRIPT_ID,
    key = key,
    hwid = hwid,
    executor = executor,
    nonce = nonce,
    proof = proof,
})
if not data then
    return warn("[2t1auth] request failed.")
end
if not data.success then
    return warn("[2t1auth] " .. tostring(data.message or "authentication failed"))
end
if type(data.script) ~= "string" or #data.script == 0 then
    return warn("[2t1auth] empty payload.")
end

-- 7) run the protected script. In session mode the payload is encrypted under a
--    key both sides derive independently; it is passed in as a vararg so it is
--    never written to a global.
local fn, err = loadChunk(data.script, "=2t1auth:" .. SCRIPT_ID)
if not fn then
    return bail("compile_failed", "failed to compile script: " .. tostring(err))
end

if data.enc == "session" then
    local sessionKey
    local ok = pcall(function()
        sessionKey = sha256raw(table.concat({ salt, nonce, SCRIPT_ID, key, hwid }, "|"))
    end)
    if not ok or type(sessionKey) ~= "string" then
        return warn("[2t1auth] could not derive session key.")
    end
    return fn(sessionKey)
end

return fn()
