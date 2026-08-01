-- SHA-256 + HMAC-SHA256 in pure Lua 5.1 / Luau.
--
-- Inlined into the loader (see src/routes/loader.js) so the client can compute
-- the same session proof and session key the server does, without any executor-
-- specific crypto library. Uses bit32 when present (always, on Luau) and falls
-- back to arithmetic bit operations otherwise.
--
-- Deliberately NOT using LuaJIT's `bit`: its ops return signed 32-bit numbers,
-- which silently breaks the modular arithmetic below.
--
-- Exposes: sha256hex(msg), sha256raw(msg), hmac256hex(key, msg)

local sha256hex, sha256raw, hmac256hex
do
    local band, bor, bxor, bnot, shr, rrot
    -- Float literal on purpose: every intermediate below stays a double, so the
    -- code behaves identically on double-only VMs (Lua 5.1, Luau) and on VMs with
    -- narrow native integers, where 32-bit sums would otherwise wrap negative.
    local MOD = 4294967296.0

    if type(bit32) == "table" and bit32.band and bit32.bxor and bit32.rshift then
        band, bor, bxor, bnot = bit32.band, bit32.bor, bit32.bxor, bit32.bnot
        shr = bit32.rshift
        rrot = bit32.rrotate or function(x, n)
            return bor(shr(x, n), bit32.lshift(x, 32 - n))
        end
    else
        local function bitop(a, b, op)
            local r, p = 0.0, 1.0
            for _ = 1, 32 do
                local x, y = a % 2, b % 2
                local v
                if op == 1 then
                    v = (x == 1 and y == 1)
                elseif op == 2 then
                    v = (x == 1 or y == 1)
                else
                    v = (x ~= y)
                end
                if v then r = r + p end
                a = (a - x) / 2
                b = (b - y) / 2
                p = p * 2
            end
            return r
        end
        band = function(a, b) return bitop(a, b, 1) end
        bor = function(a, b) return bitop(a, b, 2) end
        bxor = function(a, b) return bitop(a, b, 3) end
        bnot = function(a) return MOD - 1.0 - a end
        shr = function(a, n) return math.floor(a / 2 ^ n) % MOD end
        rrot = function(a, n) return (math.floor(a / 2 ^ n) + (a % 2 ^ n) * 2 ^ (32 - n)) % MOD end
    end

    local K = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    }

    local IV = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 }

    -- Normalise every constant into [0, 2^32) as a float. Hex literals above 2^31
    -- come out negative on VMs with 32-bit integers; `% MOD` folds them back and
    -- pins the type, so the rest of the code never has to care.
    for i = 1, 64 do K[i] = K[i] % MOD end
    for i = 1, 8 do IV[i] = IV[i] % MOD end

    local HEX = "0123456789abcdef"

    local function hex32(n)
        local s = ""
        for i = 7, 0, -1 do
            local d = math.floor(n / 16 ^ i) % 16
            s = s .. string.sub(HEX, d + 1, d + 1)
        end
        return s
    end

    local function raw32(n)
        return string.char(
            math.floor(n / 16777216) % 256,
            math.floor(n / 65536) % 256,
            math.floor(n / 256) % 256,
            n % 256
        )
    end

    -- Returns the eight 32-bit state words for `msg`.
    local function digest(msg)
        local bitlen = #msg * 8
        -- pad: 0x80, zeros, then the 64-bit big-endian bit length
        local pad = (56 - (#msg + 1) % 64) % 64
        msg = msg
            .. "\128"
            .. string.rep("\0", pad)
            .. raw32(math.floor(bitlen / MOD))
            .. raw32(bitlen % MOD)

        local h0, h1, h2, h3 = IV[1], IV[2], IV[3], IV[4]
        local h4, h5, h6, h7 = IV[5], IV[6], IV[7], IV[8]
        local w = {}

        for pos = 1, #msg, 64 do
            for i = 0, 15 do
                local p = pos + i * 4
                local b1, b2, b3, b4 = string.byte(msg, p, p + 3)
                w[i + 1] = b1 * 16777216.0 + b2 * 65536.0 + b3 * 256.0 + b4
            end
            for i = 17, 64 do
                local v = w[i - 15]
                local s0 = bxor(bxor(rrot(v, 7), rrot(v, 18)), shr(v, 3))
                v = w[i - 2]
                local s1 = bxor(bxor(rrot(v, 17), rrot(v, 19)), shr(v, 10))
                w[i] = (w[i - 16] + s0 + w[i - 7] + s1) % MOD
            end

            local a, b, c, d, e, f, g, h = h0, h1, h2, h3, h4, h5, h6, h7
            for i = 1, 64 do
                local S1 = bxor(bxor(rrot(e, 6), rrot(e, 11)), rrot(e, 25))
                local ch = bxor(band(e, f), band(bnot(e), g))
                local t1 = (h + S1 + ch + K[i] + w[i]) % MOD
                local S0 = bxor(bxor(rrot(a, 2), rrot(a, 13)), rrot(a, 22))
                local maj = bxor(bxor(band(a, b), band(a, c)), band(b, c))
                local t2 = (S0 + maj) % MOD
                h, g, f, e = g, f, e, (d + t1) % MOD
                d, c, b, a = c, b, a, (t1 + t2) % MOD
            end

            h0 = (h0 + a) % MOD
            h1 = (h1 + b) % MOD
            h2 = (h2 + c) % MOD
            h3 = (h3 + d) % MOD
            h4 = (h4 + e) % MOD
            h5 = (h5 + f) % MOD
            h6 = (h6 + g) % MOD
            h7 = (h7 + h) % MOD
        end
        return h0, h1, h2, h3, h4, h5, h6, h7
    end

    sha256hex = function(msg)
        local a, b, c, d, e, f, g, h = digest(msg)
        return hex32(a) .. hex32(b) .. hex32(c) .. hex32(d) .. hex32(e) .. hex32(f) .. hex32(g) .. hex32(h)
    end

    sha256raw = function(msg)
        local a, b, c, d, e, f, g, h = digest(msg)
        return raw32(a) .. raw32(b) .. raw32(c) .. raw32(d) .. raw32(e) .. raw32(f) .. raw32(g) .. raw32(h)
    end

    hmac256hex = function(key, msg)
        if #key > 64 then key = sha256raw(key) end
        key = key .. string.rep("\0", 64 - #key)
        local outer, inner = {}, {}
        for i = 1, 64 do
            local byte = string.byte(key, i)
            outer[i] = string.char(bxor(byte, 0x5c))
            inner[i] = string.char(bxor(byte, 0x36))
        end
        return sha256hex(table.concat(outer) .. sha256raw(table.concat(inner) .. msg))
    end
end
