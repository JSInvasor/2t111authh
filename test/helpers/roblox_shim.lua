-- Just enough Roblox/executor surface to run the real loader bootstrap in a
-- plain Lua VM. Provides game:GetService, HttpService JSON, warn and an HTTP
-- request function that bridges to the JS side via __serve.
--
-- The JSON codec here only handles what the loader actually exchanges: flat
-- objects whose values are strings, booleans or numbers.

local function esc(s)
    s = string.gsub(s, "\\", "\\\\")
    s = string.gsub(s, '"', '\\"')
    s = string.gsub(s, "\n", "\\n")
    s = string.gsub(s, "\r", "\\r")
    s = string.gsub(s, "\t", "\\t")
    return s
end

local function jsonencode(t)
    local parts = {}
    for k, v in pairs(t) do
        parts[#parts + 1] = '"' .. esc(tostring(k)) .. '":"' .. esc(tostring(v)) .. '"'
    end
    return "{" .. table.concat(parts, ",") .. "}"
end

local function jsondecode(str)
    local s, i, n = str, 1, #str

    local function skipws()
        while i <= n and string.find(string.sub(s, i, i), "%s") do i = i + 1 end
    end

    local function parsestring()
        i = i + 1 -- opening quote
        local buf = {}
        while i <= n do
            local c = string.sub(s, i, i)
            if c == '"' then
                i = i + 1
                break
            elseif c == "\\" then
                local e = string.sub(s, i + 1, i + 1)
                i = i + 2
                if e == "n" then buf[#buf + 1] = "\n"
                elseif e == "t" then buf[#buf + 1] = "\t"
                elseif e == "r" then buf[#buf + 1] = "\r"
                elseif e == "b" then buf[#buf + 1] = "\b"
                elseif e == "f" then buf[#buf + 1] = "\f"
                elseif e == "u" then
                    buf[#buf + 1] = string.char(tonumber(string.sub(s, i, i + 3), 16) % 256)
                    i = i + 4
                else
                    buf[#buf + 1] = e
                end
            else
                buf[#buf + 1] = c
                i = i + 1
            end
        end
        return table.concat(buf)
    end

    local function parsevalue()
        skipws()
        local c = string.sub(s, i, i)
        if c == '"' then return parsestring() end
        if string.sub(s, i, i + 3) == "true" then i = i + 4 return true end
        if string.sub(s, i, i + 4) == "false" then i = i + 5 return false end
        if string.sub(s, i, i + 3) == "null" then i = i + 4 return nil end
        local j = i
        while i <= n and string.find(string.sub(s, i, i), "[%d%.%-+eE]") do i = i + 1 end
        return tonumber(string.sub(s, j, i - 1))
    end

    skipws()
    if string.sub(s, i, i) ~= "{" then return nil end
    i = i + 1
    local out = {}
    skipws()
    if string.sub(s, i, i) == "}" then return out end
    while i <= n do
        skipws()
        local k = parsestring()
        skipws()
        i = i + 1 -- ':'
        out[k] = parsevalue()
        skipws()
        local c = string.sub(s, i, i)
        i = i + 1
        if c ~= "," then break end
    end
    return out
end

local HttpService = {
    JSONEncode = function(_, t) return jsonencode(t) end,
    JSONDecode = function(_, s) return jsondecode(s) end,
}

local RbxAnalyticsService = {
    GetClientId = function() return "TEST-HWID-0001-abcdef" end,
}

game = {
    GetService = function(_, name)
        if name == "HttpService" then return HttpService end
        if name == "RbxAnalyticsService" then return RbxAnalyticsService end
        error("unexpected service: " .. tostring(name))
    end,
}

function warn(...)
    local parts = {}
    for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
    __warn(table.concat(parts, " "))
end

function request(opts)
    return { StatusCode = 200, Body = __serve(opts.Url, opts.Body) }
end

function identifyexecutor()
    return "synapse"
end
