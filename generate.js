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
         * Event API format:
         *
         * date      = DD/MM/YYYY
         * time      = HH:MM or HH:MM:SS
         * end_date  = DD/MM/YYYY
         * end_time  = HH:MM or HH:MM:SS
         *
         * Times are treated as UTC.
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
         * More flexible slug extraction.
         *
         * Supported examples:
         *
         * https://example.com/pro/test.txt
         * /pro/test.txt
         * pro/test.txt
         *
         * Also handles URLs with query strings.
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

            /*
             * Fallback:
             * Search anywhere inside the links value.
             */
            const fallback = links.match(
                /\/pro\/([^/?#]+?)(?:\.txt)?(?:[?#]|$)/i
            );

            if (fallback && fallback[1]) {
                return fallback[1].trim();
            }

            return null;
        }

        function escapeM3U(value) {
            return String(value || "")
                .replace(/"/g, "'")
                .replace(/\r?\n/g, " ")
                .trim();
        }

        /*
         * Current time.
         */
        const now = new Date();

        /*
         * Only include events beginning within the next 24 hours.
         */
        const upcomingLimit = new Date(
            now.getTime() +
            24 * 60 * 60 * 1000
        );

        console.log(`Current UTC time: ${now.toISOString()}`);
        console.log(
            `24-hour cutoff: ${upcomingLimit.toISOString()}`
        );
        console.log("");

        /*
         * Start a completely fresh playlist.
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

        let debugMatchFound = false;

        /*
         * Process every event from the API.
         */
        for (const item of eventsData) {

            /*
             * IMPORTANT:
             *
             * The API may return:
             *
             * { event: {...} }
             *
             * OR:
             *
             * {...}
             *
             * The old code only supported the first format.
             */
            const event = item?.event || item;

            if (!event || typeof event !== "object") {
                skippedInvalidItem++;

                console.log(
                    "Skipping invalid event item:"
                );

                console.log(item);
                console.log("");

                continue;
            }

            totalEvents++;

            const eventName =
                event.eventName ||
                `${event.teamAName || ""} vs ${event.teamBName || ""}`.trim() ||
                "Unknown Event";

            const teamA =
                String(event.teamAName || "").toLowerCase();

            const teamB =
                String(event.teamBName || "").toLowerCase();

            const nameLower =
                String(eventName).toLowerCase();

            /*
             * DEBUG:
             *
             * Look specifically for Bahamas / Saint Martin.
             */
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
                console.log("DEBUG: BAHAMAS vs SAINT MARTIN FOUND");
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
                    "Visible:",
                    event.visible
                );

                console.log(
                    "Links:",
                    event.links
                );

                console.log(
                    "Extracted slug:",
                    getSlug(event)
                );

                console.log(
                    "Available Firebase keys containing Bahamas/Saint:",
                    Object.keys(streamsData).filter(key =>
                        key.toLowerCase().includes("bahamas") ||
                        key.toLowerCase().includes("saint")
                    )
                );

                console.log("================================");
                console.log("");
            }

            /*
             * Skip events explicitly marked invisible.
             */
            if (event.visible === false) {
                skippedHidden++;

                if (isBahamasSaintMartin) {
                    console.log(
                        "DEBUG RESULT: Bahamas vs Saint Martin was skipped because visible === false"
                    );
                }

                continue;
            }

            const start = getEventStart(event);
            const end = getEventEnd(event);

            /*
             * Invalid date/time.
             */
            if (!start || !end) {
                invalidEvents++;

                console.log(
                    `Invalid date/time: ${eventName}`
                );

                if (isBahamasSaintMartin) {
                    console.log(
                        "DEBUG RESULT: Bahamas vs Saint Martin has invalid date/time."
                    );
                }

                continue;
            }

            /*
             * Show parsed dates for the target match.
             */
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
             * EVENT HAS ENDED
             */
            if (end <= now) {
                expiredEvents++;

                console.log(
                    `Expired: ${eventName}`
                );

                if (isBahamasSaintMartin) {
                    console.log(
                        "DEBUG RESULT: Bahamas vs Saint Martin was classified as EXPIRED."
                    );

                    console.log(
                        `End ${end.toISOString()} <= Now ${now.toISOString()}`
                    );
                }

                continue;
            }

            /*
             * EVENT IS TOO FAR IN THE FUTURE
             */
            if (start > upcomingLimit) {
                futureEvents++;

                console.log(
                    `Too far ahead: ${eventName}`
                );

                if (isBahamasSaintMartin) {
                    console.log(
                        "DEBUG RESULT: Bahamas vs Saint Martin was classified as MORE THAN 24 HOURS AWAY."
                    );
                }

                continue;
            }

            /*
             * Find matching stream database entry.
             */
            const slug = getSlug(event);

            if (!slug) {
                missingStreams++;

                console.log(
                    `No slug found for: ${eventName}`
                );

                console.log(
                    "Links:",
                    event.links
                );

                if (isBahamasSaintMartin) {
                    console.log(
                        "DEBUG RESULT: Bahamas vs Saint Martin has NO SLUG."
                    );
                }

                continue;
            }

            if (!streamsData[slug]) {
                missingStreams++;

                console.log(
                    `No Firebase entry for: ${eventName}`
                );

                console.log(
                    "Slug:",
                    slug
                );

                if (isBahamasSaintMartin) {
                    console.log(
                        "DEBUG RESULT: Bahamas vs Saint Martin slug does NOT exist in Firebase."
                    );

                    console.log(
                        "Slug searched for:",
                        slug
                    );
                }

                continue;
            }

            if (!Array.isArray(streamsData[slug].streams)) {
                missingStreams++;

                console.log(
                    `Firebase entry has no streams array for: ${eventName}`
                );

                console.log(
                    "Slug:",
                    slug
                );

                if (isBahamasSaintMartin) {
                    console.log(
                        "DEBUG RESULT: Bahamas vs Saint Martin Firebase entry exists, but streams is not an array."
                    );

                    console.log(
                        "Firebase entry:",
                        JSON.stringify(
                            streamsData[slug],
                            null,
                            2
                        )
                    );
                }

                continue;
            }

            /*
             * If we reached here, the target event passed
             * every filtering step.
             */
            if (isBahamasSaintMartin) {
                console.log("");
                console.log("================================");
                console.log(
                    "DEBUG RESULT: BAHAMAS vs SAINT MARTIN PASSED ALL FILTERS"
                );
                console.log("================================");

                console.log(
                    "Firebase slug:",
                    slug
                );

                console.log(
                    "Number of streams:",
                    streamsData[slug].streams.length
                );

                console.log("================================");
                console.log("");
            }

            /*
             * Event metadata.
             */
            const category =
                event.category || "Live Sports";

            const logo =
                event.eventLogo || "";

            let matchTitle = eventName;

            if (event.teamAName && event.teamBName) {
                matchTitle +=
                    ` (${event.teamAName} vs ${event.teamBName})`;
            }

            const folderName =
                `${category}: ${matchTitle}`;

            /*
             * Add every available stream for this event.
             */
            for (const stream of streamsData[slug].streams) {

                if (!stream) {
                    continue;
                }

                const streamName =
                    stream.name || "Live Stream";

                const linkTag =
                    stream.linkTag
                        ? ` [${stream.linkTag}]`
                        : "";

                let streamUrl =
                    stream.link || "";

                const drmKey =
                    stream.api || "";

                /*
                 * Ignore empty/placeholder stream URLs.
                 */
                if (
                    !streamUrl ||
                    streamUrl === "https://no.link"
                ) {
                    if (isBahamasSaintMartin) {
                        console.log(
                            "DEBUG: Target match has an empty/placeholder stream URL."
                        );
                    }

                    continue;
                }

                /*
                 * Normalize headers after "|".
                 */
                let streamHeaders = "";

                if (streamUrl.includes("|")) {

                    let [url, headers] =
                        streamUrl.split("|", 2);

                    headers = headers
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
                        url + "|" + headers;

                    streamHeaders = headers;
                }

                /*
                 * M3U event entry.
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

                if (isBahamasSaintMartin) {
                    console.log(
                        "DEBUG: Added target stream:",
                        streamName
                    );
                }
            }
        }

        /*
         * If the target match was never encountered at all,
         * this tells us the API did not return it in the expected form.
         */
        if (!debugMatchFound) {
            console.log("");
            console.log("================================");
            console.log(
                "DEBUG RESULT: BAHAMAS vs SAINT MARTIN WAS NOT FOUND IN API RESPONSE"
            );
            console.log("================================");

            console.log(
                "The generator processed:",
                totalEvents,
                "events."
            );

            console.log(
                "This means the event API response did not contain a recognizable Bahamas vs Saint Martin event."
            );

            console.log("================================");
            console.log("");
        }

        /*
         * ALWAYS overwrite playlist.m3u.
         */
        fs.writeFileSync(
            "playlist.m3u",
            m3u,
            "utf8"
        );

        console.log("");
        console.log("================================");
        console.log("Playlist successfully generated");
        console.log("================================");

        console.log(
            `Total valid API events processed: ${totalEvents}`
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
