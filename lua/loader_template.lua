--[==[
    2t1auth loader
    script : {{SCRIPT_NAME}}
    id     : {{SCRIPT_ID}}

    Usage (paste in your executor):
        script_key = "YOUR_KEY_HERE"
        loadstring(game:HttpGet("{{API_URL}}/loader/{{SCRIPT_ID}}.lua"))()

    Flow (mutually authenticated, anchored on the license key):
        handshake    -> we send SHA256("2t1kh|"..key); never the key itself
        server_proof -> HMAC(key, frame{"2t1srv", nonce, salt, script})
                        verified HERE, before we send anything else. Only the
                        real server knows the key, so an endpoint that merely
                        answers this URL cannot get past this line.
        proof        -> HMAC(key, frame{"2t1cli", nonce, script, hwid, executor,
                                        device, env})
        auth         -> encrypted payload, keyed by
                        SHA256(frame{"2t1sk", salt, nonce, script, key, hwid})
        resp_proof   -> HMAC(key, frame{"2t1res", nonce, enc, lease, script})
                        covers `enc`, so the response cannot be downgraded from
                        session-encrypted to plaintext in flight.
    The key never travels, and the payload never carries its own cipher key, so
    a captured exchange is inert outside the session that requested it.

    `frame` (see the inlined sha256 block) length-prefixes every field, so the
    hashed message parses unambiguously no matter what a field contains. The
    first field is always a domain tag, so a proof built for one step can never
    be replayed as another.
]==]

local API_URL   = "{{API_URL}}"
local SCRIPT_ID = "{{SCRIPT_ID}}"
-- Set by the server at render time. When true, a response that is not
-- session-encrypted is refused outright rather than executed.
local REQUIRE_SESSION = {{REQUIRE_SESSION}}
-- Whether a caught hook stops the run or is only reported. A hook that bothers
-- to wrap itself in newcclosure slips past the check either way, so this trades
-- a weak barrier against locking out the executors that wrap these functions
-- legitimately. Off, the signal still reaches the dashboard.
local HARD_STOP = {{HARD_STOP}}

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

-- A device id of our own, kept in the executor's own filesystem. The client id
-- above has public spoofers and is one value to fake; this one is generated
-- here, never derived from anything guessable, and survives a spoofed client id
-- or a reinstall of the game. It is lost if the user wipes the executor's
-- workspace, which is why it is one signal among several rather than the lock.
local deviceToken = ""
pcall(function()
    if not (readfile and writefile and isfile) then return end
    local file = "2t1auth_device.txt"
    if isfile(file) then
        deviceToken = string.gsub(tostring(readfile(file)), "[^%x]", "")
    end
    if #deviceToken < 32 then
        math.randomseed(((tick and math.floor(tick() * 1000000)) or os.time()) % 2147483647)
        local hex, out = "0123456789abcdef", {}
        for i = 1, 32 do
            local j = math.random(1, 16)
            out[i] = string.sub(hex, j, j)
        end
        deviceToken = table.concat(out)
        writefile(file, deviceToken)
    end
    deviceToken = string.sub(deviceToken, 1, 64)
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

-- Identify the key by hash. This is what goes on the wire in every request;
-- the key itself never leaves this script.
local kh = sha256hex("2t1kh|" .. key)

-- Verify a handshake response really came from our server. Returns nonce+salt on
-- success, nil otherwise. Only something holding our key can produce the proof.
local function verifyHandshake(hs)
    if not hs or not hs.success or not hs.nonce then return nil end
    local n, s = tostring(hs.nonce), tostring(hs.salt or "")
    local expect = ""
    pcall(function()
        expect = hmac256hex(key, frame({ "2t1srv", n, s, SCRIPT_ID }))
    end)
    if #expect == 0 or tostring(hs.server_proof or "") ~= expect then return nil end
    return n, s
end

-- Tell the server a client-side check tripped. Best effort — a failed report
-- never changes what we do next.
--
-- A report opens its own handshake, for two reasons. It proves the report comes
-- from someone actually holding this key (reports can trigger an auto-ban, so an
-- unauthenticated one would be a way to get anyone's key banned), and it lets us
-- authenticate the server first, so a hostile endpoint never receives our
-- telemetry. `kh` goes on the wire, never the key.
local function report(reason)
    pcall(function()
        local n = verifyHandshake(post(API_URL .. "/api/v1/handshake", { script_id = SCRIPT_ID, kh = kh }))
        if not n then return end
        post(API_URL .. "/api/v1/report", {
            script_id = SCRIPT_ID,
            kh = kh,
            nonce = n,
            proof = hmac256hex(key, frame({ "2t1rep", n, SCRIPT_ID, tostring(reason) })),
            executor = executor,
            hwid = hwid,
            reason = reason,
        })
    end)
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

-- Hard stops, unless the server asked for these to be advisory only.
if hooked(httpRequest) then
    if HARD_STOP then return bail("hook:http", "tampered HTTP function detected.") end
    report("hook:http")
end
if hooked(loadChunk) then
    if HARD_STOP then return bail("hook:loadstring", "tampered loadstring detected.") end
    report("hook:loadstring")
end

-- Advisory signals.
local jsonEncode, jsonDecode
pcall(function()
    jsonEncode, jsonDecode = HttpService.JSONEncode, HttpService.JSONDecode
end)
if hooked(jsonEncode) or hooked(jsonDecode) then report("hook:json") end

-- Cross-check with the debug library: a genuine executor primitive reports "[C]"
-- as its source, a Lua-level replacement reports a real chunk name.
local httpSource = ""
if debug and debug.info then
    local ok, src = pcall(debug.info, httpRequest, "s")
    if ok and type(src) == "string" then
        httpSource = src
        if #src > 0 and src ~= "[C]" then report("hook:http_source") end
    end
end

-- A fingerprint of what this environment looks like. The server pins whatever
-- it sees on a key's first successful auth and compares afterwards, so a machine
-- that later grows a hook, swaps executor, or turns out to be a different person
-- entirely stops looking like the machine that bought the key.
--
-- Note what this is and isn't: the client reports it, so a determined attacker
-- can report whatever they like. It is a signal, weighed with the others — not
-- a gate, and never treated as proof.
local envFp = ""
pcall(function()
    envFp = sha256hex(
        table.concat({
            executor,
            isCClosure and "ic1" or "ic0",
            hooked(httpRequest) and "h1" or "h0",
            hooked(loadChunk) and "l1" or "l0",
            httpSource,
            tostring(type(getgenv)),
            tostring(type(hookfunction)),
            tostring(type(getrawmetatable)),
        }, "|")
    )
end)

-- 5) handshake -> single-use nonce + session salt + the server's own proof
local hs = post(API_URL .. "/api/v1/handshake", { script_id = SCRIPT_ID, kh = kh })
if not hs or not hs.success then
    return warn("[2t1auth] " .. tostring(hs and hs.message or "handshake failed."))
end

-- 6) AUTHENTICATE THE SERVER before telling it anything.
--    Only something holding our key can produce that HMAC. Anything else that
--    answers this URL — a hostile proxy, a poisoned DNS entry, a captive portal
--    — fails here, and we stop while it still knows nothing but our key's hash.
--    Deliberately not reported: the report would go to that same endpoint.
local nonce, salt = verifyHandshake(hs)
if not nonce then
    return warn("[2t1auth] server verification failed — refusing to continue.")
end

-- 7) prove we hold the key, over the exact request we're sending. The key never
--    goes on the wire, so a captured request reveals nothing reusable and
--    editing any field of it invalidates the proof.
local proof = ""
pcall(function()
    proof = hmac256hex(key, frame({ "2t1cli", nonce, SCRIPT_ID, hwid, executor, deviceToken, envFp }))
end)

local data = post(API_URL .. "/api/v1/auth", {
    script_id = SCRIPT_ID,
    kh = kh,
    hwid = hwid,
    executor = executor,
    device = deviceToken,
    env = envFp,
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

-- 8) verify the payload really came from the server, unmodified. `enc` is inside
--    the HMAC, so a response cannot be downgraded to plaintext to make us run
--    attacker-supplied Lua.
local enc = tostring(data.enc or "")
local leaseId = tostring(data.lease or "")
local respExpect = ""
pcall(function()
    respExpect = hmac256hex(key, frame({ "2t1res", nonce, enc, leaseId, data.script }))
end)
if #respExpect == 0 or tostring(data.resp_proof or "") ~= respExpect then
    return bail("resp_proof", "payload verification failed — refusing to run it.")
end
if REQUIRE_SESSION and enc ~= "session" then
    return bail("downgrade", "server did not session-encrypt the payload — refusing to run it.")
end

-- 9) keep the session alive. The server hands back a lease; we beat against it
--    on an interval and it answers "keep going" or "you're revoked". This is
--    what lets a ban reach a script that is already running, and what turns key
--    sharing into a live signal instead of a guess about past log rows.
--
--    The flag lives on a shared global so the protected script can cooperate:
--        if getgenv().__2t1 and getgenv().__2t1.revoked then return end
--    Stopping the run outright is up to the script — nothing here can safely
--    tear down connections it already made.
local session = { revoked = false, lease = leaseId }
if getgenv then getgenv().__2t1 = session end

if #leaseId > 0 then
    local beatEvery = tonumber(data.beat_every) or 60
    local spawn = (task and task.spawn) or spawn
    local wait = (task and task.wait) or wait

    local function heartbeat()
        local n = 0
        while not session.revoked do
            wait(beatEvery)
            n = n + 1
            local beat
            local ok = pcall(function()
                beat = hmac256hex(key, frame({ "2t1hb", leaseId, tostring(n) }))
            end)
            if not ok then return end

            local reply = post(API_URL .. "/api/v1/heartbeat", { lease = leaseId, n = n, beat = beat })
            -- Only an explicit revocation stops us. A dropped request is just a
            -- dropped request: the lease TTL covers several missed beats, and
            -- killing a paying user's session over one timeout is worse than
            -- letting a revoked one run until the next beat lands.
            if reply and reply.revoked then
                session.revoked = true
                return warn("[2t1auth] " .. tostring(reply.message or "session revoked."))
            end
        end
    end

    if spawn then spawn(heartbeat) end
end

-- 10) run the protected script. In session mode the payload is encrypted under a
--     key both sides derive independently; it is passed in as a vararg so it is
--     never written to a global.
local fn, err = loadChunk(data.script, "=2t1auth:" .. SCRIPT_ID)
if not fn then
    return bail("compile_failed", "failed to compile script: " .. tostring(err))
end

if enc == "session" then
    local sessionKey
    local ok = pcall(function()
        sessionKey = sha256raw(frame({ "2t1sk", salt, nonce, SCRIPT_ID, key, hwid }))
    end)
    if not ok or type(sessionKey) ~= "string" then
        return warn("[2t1auth] could not derive session key.")
    end
    return fn(sessionKey)
end

return fn()
