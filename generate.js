const fs = require("fs");

async function generateM3U() {
    const eventsUrl =
        "https://ratulxadia-playz-cats-event.hf.space/api/events";

    const streamsUrl =
        "https://ratul-liv-default-rtdb.asia-southeast1.firebasedatabase.app/playz-streams.json";

    try {
        const fetchOptions = {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
                "Accept": "application/json"
            }
        };

        console.log("================================");
        console.log("Starting M3U generation");
        console.log("================================");
        console.log("");

        console.log("Fetching event and stream data...");

        const [eventsRes, streamsRes] = await Promise.all([
            fetch(eventsUrl, fetchOptions),
            fetch(streamsUrl, fetchOptions)
        ]);

        if (!eventsRes.ok) {
            throw new Error(
                `Events API returned ${eventsRes.status} ${eventsRes.statusText}`
            );
        }

        if (!streamsRes.ok) {
            throw new Error(
                `Streams API returned ${streamsRes.status} ${streamsRes.statusText}`
            );
        }

        const eventsData = await eventsRes.json();
        const streamsData = await streamsRes.json();

        if (!Array.isArray(eventsData)) {
            throw new Error("Events API did not return an array.");
        }

        if (!streamsData || typeof streamsData !== "object") {
            throw new Error("Streams API returned invalid data.");
        }

        console.log(`Events API returned ${eventsData.length} items.`);
        console.log(
            `Firebase returned ${Object.keys(streamsData).length} stream entries.`
        );
        console.log("");

        /*
         * Event API dates/times are treated as UTC.
         */
        function parseDateTime(dateString, timeString) {
            if (!dateString || !timeString) {
                return null;
            }

            const dateParts = String(dateString)
                .trim()
                .split("/");

            if (dateParts.length !== 3) {
                return null;
            }

            const [day, month, year] = dateParts;

            const timeParts = String(timeString)
                .trim()
                .split(":");

            if (timeParts.length < 2) {
                return null;
            }

            const hour = timeParts[0].padStart(2, "0");
            const minute = timeParts[1].padStart(2, "0");
            const second = (timeParts[2] || "00").padStart(2, "0");

            const isoString =
                `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` +
                `T${hour}:${minute}:${second}Z`;

            const result = new Date(isoString);

            if (Number.isNaN(result.getTime())) {
                return null;
            }

            return result;
        }

        function getEventStart(event) {
            return parseDateTime(
                event.date,
                event.time
            );
        }

        function getEventEnd(event) {
            return parseDateTime(
                event.end_date || event.date,
                event.end_time || event.time
            );
        }

        /*
         * Extract the Firebase slug from the event's links field.
         *
         * Example:
         *
         * pro/ABC123.txt
         *
         * becomes:
         *
         * ABC123
         */
        function getSlug(event) {
            if (!event || !event.links) {
                return null;
            }

            const links = String(event.links).trim();

            const match = links.match(
                /(?:^|\/)pro\/([^/?#]+?)(?:\.txt)?(?:[?#].*)?$/i
            );

            if (match && match[1]) {
                return match[1].trim();
            }

            const fallback = links.match(
                /\/pro\/([^/?#]+?)(?:\.txt)?(?:[?#]|$)/i
            );

            if (fallback && fallback[1]) {
                return fallback[1].trim();
            }

            return null;
        }

        /*
         * Decode a Firebase key.
         *
         * The stream database keys are Base64 encoded.
         *
         * Example:
         *
         * Q09OQ0FDQUYgTmF0aW9ucyBMZWFndWUt...
         *
         * becomes something similar to:
         *
         * CONCACAF Nations League-Bahamas-vs-Saint Martin1790052310382
         */
        function decodeBase64(value) {
            if (!value) {
                return null;
            }

            try {
                return Buffer.from(
                    String(value),
                    "base64"
                ).toString("utf8");
            } catch {
                return null;
            }
        }

        /*
         * Remove the generated timestamp at the end of decoded
         * Firebase event identifiers.
         *
         * Example:
         *
         * CONCACAF Nations League-Bahamas-vs-Saint Martin1790052310382
         *
         * becomes:
         *
         * CONCACAF Nations League-Bahamas-vs-Saint Martin
         */
        function removeTrailingTimestamp(value) {
            if (!value) {
                return "";
            }

            return String(value)
                .replace(/\d{8,}$/, "")
                .trim();
        }

        /*
         * Normalize text so that small differences in:
         *
         * - capitalization
         * - punctuation
         * - spaces
         * - hyphens
         *
         * don't prevent matching.
         */
        function normalizeText(value) {
            return String(value || "")
                .toLowerCase()
                .normalize("NFKD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/&/g, " and ")
                .replace(/[^a-z0-9]+/g, " ")
                .replace(/\s+/g, " ")
                .trim();
        }

        /*
         * Convert an event into several searchable strings.
         *
         * We intentionally use multiple forms because the event API
         * and Firebase may format the same match differently.
         */
        function getEventMatchStrings(event) {
            const eventName =
                event.eventName || "";

            const teamA =
                event.teamAName || "";

            const teamB =
                event.teamBName || "";

            const fullName =
                `${eventName} ${teamA} ${teamB}`;

            const teams =
                `${teamA} ${teamB}`;

            const matchup =
                `${teamA} vs ${teamB}`;

            const reverseMatchup =
                `${teamB} vs ${teamA}`;

            return {
                eventName: normalizeText(eventName),
                teams: normalizeText(teams),
                matchup: normalizeText(matchup),
                reverseMatchup: normalizeText(reverseMatchup),
                full: normalizeText(fullName)
            };
        }

        /*
         * Get a useful representation of a Firebase key.
         */
        function decodeFirebaseKey(key) {
            const decoded = decodeBase64(key);

            if (!decoded) {
                return null;
            }

            const withoutTimestamp =
                removeTrailingTimestamp(decoded);

            return {
                key,
                decoded,
                normalized: normalizeText(withoutTimestamp)
            };
        }

        /*
         * Build a decoded Firebase-key index once.
         *
         * This is much faster than decoding every Firebase key
         * repeatedly for every event.
         */
        const firebaseIndex = [];

        for (const key of Object.keys(streamsData)) {
            const decoded = decodeFirebaseKey(key);

            if (!decoded) {
                continue;
            }

            firebaseIndex.push(decoded);
        }

        console.log(
            `Decoded ${firebaseIndex.length} Firebase keys for fallback matching.`
        );

        console.log("");
console.log("================================");
console.log("ALL DECODED FIREBASE KEYS");
console.log("================================");

for (const entry of firebaseIndex) {
    console.log(entry.decoded);
}

console.log("================================");
console.log("");

        /*
         * Find a Firebase stream entry for an event.
         *
         * Matching order:
         *
         * 1. Exact slug.
         * 2. Exact normalized decoded Firebase event name.
         * 3. Team matchup contained inside decoded key.
         * 4. Both team names contained inside decoded key.
         */
        function findStreamEntry(event) {
            const slug = getSlug(event);

            /*
             * ----------------------------------------
             * METHOD 1: EXACT SLUG MATCH
             * ----------------------------------------
             */
            if (
                slug &&
                streamsData[slug] &&
                Array.isArray(streamsData[slug].streams)
            ) {
                return {
                    data: streamsData[slug],
                    key: slug,
                    method: "exact slug"
                };
            }

            /*
             * ----------------------------------------
             * METHOD 2+: FALLBACK DECODED MATCH
             * ----------------------------------------
             */
            const matchStrings =
                getEventMatchStrings(event);

            /*
             * Don't attempt a broad fallback when there
             * aren't team names or an event name.
             */
            if (
                !matchStrings.eventName &&
                !matchStrings.teams
            ) {
                return null;
            }

            /*
             * First try to identify both teams.
             */
            if (
                matchStrings.eventName &&
                event.teamAName &&
                event.teamBName
            ) {
                const teamA =
                    normalizeText(event.teamAName);

                const teamB =
                    normalizeText(event.teamBName);

                const teamMatch =
                    firebaseIndex.filter(entry => {
                        return (
                            entry.normalized.includes(teamA) &&
                            entry.normalized.includes(teamB)
                        );
                    });

                if (teamMatch.length === 1) {
                    const found = teamMatch[0];

                    if (
                        streamsData[found.key] &&
                        Array.isArray(
                            streamsData[found.key].streams
                        )
                    ) {
                        return {
                            data: streamsData[found.key],
                            key: found.key,
                            decodedKey: found.decoded,
                            method: "fallback team match"
                        };
                    }
                }

                /*
                 * If multiple results exist, prefer one whose
                 * decoded key also contains the event name/category.
                 */
                if (teamMatch.length > 1) {
                    const eventName =
                        matchStrings.eventName;

                    const betterMatches =
                        teamMatch.filter(entry =>
                            entry.normalized.includes(eventName)
                        );

                    if (betterMatches.length === 1) {
                        const found = betterMatches[0];

                        if (
                            streamsData[found.key] &&
                            Array.isArray(
                                streamsData[found.key].streams
                            )
                        ) {
                            return {
                                data: streamsData[found.key],
                                key: found.key,
                                decodedKey: found.decoded,
                                method: "fallback team + event match"
                            };
                        }
                    }
                }
            }

            /*
             * ----------------------------------------
             * METHOD 3: NORMALIZED FULL EVENT MATCH
             * ----------------------------------------
             */
            const normalizedCandidates =
                firebaseIndex.filter(entry => {

                    if (
                        matchStrings.full &&
                        entry.normalized === matchStrings.full
                    ) {
                        return true;
                    }

                    if (
                        matchStrings.matchup &&
                        entry.normalized.includes(
                            matchStrings.matchup
                        )
                    ) {
                        return true;
                    }

                    if (
                        matchStrings.reverseMatchup &&
                        entry.normalized.includes(
                            matchStrings.reverseMatchup
                        )
                    ) {
                        return true;
                    }

                    return false;
                });

            if (normalizedCandidates.length === 1) {
                const found =
                    normalizedCandidates[0];

                if (
                    streamsData[found.key] &&
                    Array.isArray(
                        streamsData[found.key].streams
                    )
                ) {
                    return {
                        data: streamsData[found.key],
                        key: found.key,
                        decodedKey: found.decoded,
                        method: "fallback normalized match"
                    };
                }
            }

            return null;
        }

        function escapeM3U(value) {
            return String(value || "")
                .replace(/"/g, "'")
                .replace(/\r?\n/g, " ")
                .trim();
        }

        const now = new Date();

        const upcomingLimit =
            new Date(
                now.getTime() +
                24 * 60 * 60 * 1000
            );

        console.log(
            `Current UTC time: ${now.toISOString()}`
        );

        console.log(
            `24-hour cutoff: ${upcomingLimit.toISOString()}`
        );

        console.log("");

        /*
         * Always create a fresh playlist.
         */
        let m3u =
            `#EXTM3U\n\n` +
            `#EXTINF:-1 tvg-logo="https://telegram.org/img/t_logo.png" group-title="📢 SOCIAL MEDIA", 🚀 JOIN TELEGRAM CHANNEL\n` +
            `https://raw.githubusercontent.com/aiorbd-video/video/refs/heads/main/test1/output.m3u8\n\n` +
            `#EXTINF:-1 tvg-logo="https://upload.wikimedia.org/wikipedia/commons/b/b8/2021_Facebook_icon.svg" group-title="📢 SOCIAL MEDIA", 🌐 JOIN FACEBOOK GROUP\n` +
            `https://raw.githubusercontent.com/aiorbd-video/video/refs/heads/main/Allinonesocialvid/output.m3u8\n\n`;

        let totalEvents = 0;
        let skippedInvalidItem = 0;
        let skippedHidden = 0;
        let invalidEvents = 0;
        let expiredEvents = 0;
        let futureEvents = 0;
        let missingStreams = 0;
        let generatedStreams = 0;
        let fallbackMatches = 0;

        let debugMatchFound = false;

        /*
         * Process events.
         */
        for (const item of eventsData) {

            /*
             * Support both:
             *
             * { event: {...} }
             *
             * and:
             *
             * {...}
             */
            const event =
                item?.event || item;

            if (
                !event ||
                typeof event !== "object"
            ) {
                skippedInvalidItem++;

                console.log(
                    "Skipping invalid event item:",
                    item
                );

                continue;
            }

            totalEvents++;

            const eventName =
                event.eventName ||
                `${event.teamAName || ""} vs ${event.teamBName || ""}`.trim() ||
                "Unknown Event";

            const nameLower =
                String(eventName).toLowerCase();

            const teamA =
                String(event.teamAName || "")
                    .toLowerCase();

            const teamB =
                String(event.teamBName || "")
                    .toLowerCase();

            const isBahamasSaintMartin =
                (
                    nameLower.includes("bahamas") &&
                    nameLower.includes("saint martin")
                ) ||
                (
                    teamA.includes("bahamas") &&
                    teamB.includes("saint martin")
                ) ||
                (
                    teamB.includes("bahamas") &&
                    teamA.includes("saint martin")
                );

            if (isBahamasSaintMartin) {
                debugMatchFound = true;

                console.log("");
                console.log("================================");
                console.log(
                    "DEBUG: BAHAMAS vs SAINT MARTIN FOUND"
                );
                console.log("================================");

                console.log(
                    "Event name:",
                    event.eventName
                );

                console.log(
                    "Team A:",
                    event.teamAName
                );

                console.log(
                    "Team B:",
                    event.teamBName
                );

                console.log(
                    "Date:",
                    event.date
                );

                console.log(
                    "Time:",
                    event.time
                );

                console.log(
                    "End date:",
                    event.end_date
                );

                console.log(
                    "End time:",
                    event.end_time
                );

                console.log(
                    "Links:",
                    event.links
                );

                console.log(
                    "Original slug:",
                    getSlug(event)
                );

                console.log("================================");
                console.log("");
            }

            /*
             * Skip hidden events.
             */
            if (event.visible === false) {
                skippedHidden++;

                if (isBahamasSaintMartin) {
                    console.log(
                        "DEBUG RESULT: Event is hidden."
                    );
                }

                continue;
            }

            const start =
                getEventStart(event);

            const end =
                getEventEnd(event);

            if (!start || !end) {
                invalidEvents++;

                console.log(
                    `Invalid date/time: ${eventName}`
                );

                if (isBahamasSaintMartin) {
                    console.log(
                        "DEBUG RESULT: Invalid date/time."
                    );
                }

                continue;
            }

            if (isBahamasSaintMartin) {
                console.log(
                    "Parsed start:",
                    start.toISOString()
                );

                console.log(
                    "Parsed end:",
                    end.toISOString()
                );

                console.log(
                    "Current time:",
                    now.toISOString()
                );
            }

            /*
             * Remove events whose end time has passed.
             */
            if (end <= now) {
                expiredEvents++;

                console.log(
                    `Expired: ${eventName}`
                );

                if (isBahamasSaintMartin) {
                    console.log(
                        "DEBUG RESULT: Event is expired."
                    );
                }

                continue;
            }

            /*
             * Do not include events more than 24 hours away.
             */
            if (start > upcomingLimit) {
                futureEvents++;

                console.log(
                    `Too far ahead: ${eventName}`
                );

                if (isBahamasSaintMartin) {
                    console.log(
                        "DEBUG RESULT: Event is more than 24 hours away."
                    );
                }

                continue;
            }

            /*
             * Find stream data using exact or fallback matching.
             */
            const streamMatch =
                findStreamEntry(event);

            if (!streamMatch) {
                missingStreams++;

                console.log(
                    `No Firebase entry for: ${eventName}`
                );

                console.log(
                    "Slug:",
                    getSlug(event)
                );

                if (isBahamasSaintMartin) {
                    console.log("");
                    console.log(
                        "DEBUG RESULT: No Firebase match found, even after fallback matching."
                    );

                    console.log(
                        "Decoded Firebase candidates containing team names:"
                    );

                    const teamAName =
                        normalizeText(
                            event.teamAName
                        );

                    const teamBName =
                        normalizeText(
                            event.teamBName
                        );

                    const candidates =
                        firebaseIndex.filter(entry =>
                            (
                                teamAName &&
                                entry.normalized.includes(
                                    teamAName
                                )
                            ) ||
                            (
                                teamBName &&
                                entry.normalized.includes(
                                    teamBName
                                )
                            )
                        );

                    for (
                        const candidate of candidates.slice(0, 10)
                    ) {
                        console.log(
                            candidate.decoded
                        );
                    }

                    console.log("");
                }

                continue;
            }

            const streamsEntry =
                streamMatch.data;

            /*
             * Report fallback matches.
             */
            if (
                streamMatch.method !==
                "exact slug"
            ) {
                fallbackMatches++;

                console.log(
                    `Fallback Firebase match: ${eventName}`
                );

                console.log(
                    `Match method: ${streamMatch.method}`
                );

                console.log(
                    `Firebase key: ${streamMatch.key}`
                );

                console.log(
                    `Decoded key: ${streamMatch.decodedKey}`
                );
            }

            /*
             * Target-match diagnostics.
             */
            if (isBahamasSaintMartin) {
                console.log("");
                console.log("================================");
                console.log(
                    "DEBUG RESULT: BAHAMAS vs SAINT MARTIN MATCHED"
                );
                console.log("================================");

                console.log(
                    "Match method:",
                    streamMatch.method
                );

                console.log(
                    "Firebase key:",
                    streamMatch.key
                );

                console.log(
                    "Decoded Firebase key:",
                    streamMatch.decodedKey
                );

                console.log(
                    "Number of streams:",
                    streamsEntry.streams.length
                );

                console.log("================================");
                console.log("");
            }

            /*
             * Event metadata.
             */
            const category =
                event.category ||
                "Live Sports";

            const logo =
                event.eventLogo ||
                "";

            let matchTitle =
                eventName;

            if (
                event.teamAName &&
                event.teamBName
            ) {
                matchTitle +=
                    ` (${event.teamAName} vs ${event.teamBName})`;
            }

            const folderName =
                `${category}: ${matchTitle}`;

            /*
             * Add all streams.
             */
            for (
                const stream of streamsEntry.streams
            ) {
                if (!stream) {
                    continue;
                }

                const streamName =
                    stream.name ||
                    "Live Stream";

                const linkTag =
                    stream.linkTag
                        ? ` [${stream.linkTag}]`
                        : "";

                let streamUrl =
                    stream.link ||
                    "";

                const drmKey =
                    stream.api ||
                    "";

                /*
                 * Ignore empty placeholder URLs.
                 */
                if (
                    !streamUrl ||
                    streamUrl ===
                    "https://no.link"
                ) {
                    if (
                        isBahamasSaintMartin
                    ) {
                        console.log(
                            "DEBUG: Target match has an empty/placeholder stream URL."
                        );
                    }

                    continue;
                }

                /*
                 * Normalize stream headers.
                 */
                let streamHeaders = "";

                if (
                    streamUrl.includes("|")
                ) {
                    let [
                        url,
                        headers
                    ] =
                        streamUrl.split(
                            "|",
                            2
                        );

                    headers =
                        headers
                            .replace(
                                /user-agent=/gi,
                                "User-Agent="
                            )
                            .replace(
                                /referer=/gi,
                                "Referer="
                            )
                            .replace(
                                /origin=/gi,
                                "Origin="
                            )
                            .replace(
                                /cookie=/gi,
                                "Cookie="
                            );

                    streamUrl =
                        url +
                        "|" +
                        headers;

                    streamHeaders =
                        headers;
                }

                /*
                 * M3U entry.
                 */
                m3u +=
                    `#EXTINF:-1 ` +
                    `tvg-logo="${escapeM3U(logo)}" ` +
                    `group-title="${escapeM3U(folderName)}",` +
                    `${escapeM3U(streamName)}${linkTag}\n`;

                /*
                 * Preserve existing DRM metadata.
                 */
                if (drmKey) {
                    m3u +=
                        `#KODIPROP:inputstream.adaptive.license_type=clearkey\n`;

                    m3u +=
                        `#KODIPROP:inputstream.adaptive.license_key=${drmKey}\n`;
                }

                /*
                 * Preserve stream headers.
                 */
                if (streamHeaders) {
                    m3u +=
                        `#KODIPROP:inputstream.adaptive.stream_headers=${streamHeaders}\n`;
                }

                m3u +=
                    `${streamUrl}\n\n`;

                generatedStreams++;

                if (
                    isBahamasSaintMartin
                ) {
                    console.log(
                        "DEBUG: Added target stream:",
                        streamName
                    );
                }
            }
        }

        /*
         * Tell us if the target event wasn't in the API.
         */
        if (!debugMatchFound) {
            console.log("");
            console.log("================================");
            console.log(
                "DEBUG RESULT: BAHAMAS vs SAINT MARTIN WAS NOT FOUND IN API RESPONSE"
            );
            console.log("================================");
            console.log("");
        }

        /*
         * Always overwrite the playlist.
         */
        fs.writeFileSync(
            "playlist.m3u",
            m3u,
            "utf8"
        );

        console.log("");
        console.log("================================");
        console.log(
            "Playlist successfully generated"
        );
        console.log("================================");

        console.log(
            `Total API events: ${totalEvents}`
        );

        console.log(
            `Invalid API items skipped: ${skippedInvalidItem}`
        );

        console.log(
            `Hidden events skipped: ${skippedHidden}`
        );

        console.log(
            `Invalid events skipped: ${invalidEvents}`
        );

        console.log(
            `Expired events removed: ${expiredEvents}`
        );

        console.log(
            `Events >24h away skipped: ${futureEvents}`
        );

        console.log(
            `Events with no stream data: ${missingStreams}`
        );

        console.log(
            `Fallback Firebase matches: ${fallbackMatches}`
        );

        console.log(
            `Streams generated: ${generatedStreams}`
        );

        console.log(
            `Generated at: ${now.toISOString()}`
        );

        console.log(
            "Output: playlist.m3u"
        );

        console.log("================================");

    } catch (error) {
        console.error("");
        console.error(
            "ERROR: Failed to generate M3U playlist."
        );

        console.error(error);

        console.error("");

        process.exit(1);
    }
}

generateM3U();
