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

        console.log("Fetching event and stream data...");

        // Fetch both sources at the same time.
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

        /*
         * Event API format:
         *
         * date      = DD/MM/YYYY
         * time      = HH:MM or HH:MM:SS
         * end_date  = DD/MM/YYYY
         * end_time  = HH:MM or HH:MM:SS
         *
         * The event API times are treated as UTC.
         *
         * Example:
         * 23/09/2026 + 20:00:00
         *
         * becomes:
         * 2026-09-23T20:00:00Z
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
         * Existing event link format:
         *
         * .../pro/<slug>.txt
         */
        function getSlug(event) {
            if (!event.links) {
                return null;
            }

            const match = String(event.links).match(
                /pro\/(.*?)\.txt/
            );

            return match && match[1]
                ? match[1]
                : null;
        }

        function escapeM3U(value) {
            return String(value || "")
                .replace(/"/g, "'")
                .replace(/\r?\n/g, " ")
                .trim();
        }

        /*
         * Capture the current time ONCE.
         *
         * Date#getTime() is UTC-based, so this can be compared
         * directly with the UTC dates produced above.
         */
        const now = new Date();

        /*
         * Only include events that start within the next 24 hours.
         */
        const upcomingLimit = new Date(
            now.getTime() +
            24 * 60 * 60 * 1000
        );

        /*
         * Start a completely fresh playlist.
         *
         * The previous playlist is NOT read.
         * Therefore old events cannot remain simply because they
         * existed in yesterday's playlist.
         */
        let m3u =
            `#EXTM3U\n\n` +
            `#EXTINF:-1 tvg-logo="https://telegram.org/img/t_logo.png" group-title="📢 SOCIAL MEDIA", 🚀 JOIN TELEGRAM CHANNEL\n` +
            `https://raw.githubusercontent.com/aiorbd-video/video/refs/heads/main/test1/output.m3u8\n\n` +
            `#EXTINF:-1 tvg-logo="https://upload.wikimedia.org/wikipedia/commons/b/b8/2021_Facebook_icon.svg" group-title="📢 SOCIAL MEDIA", 🌐 JOIN FACEBOOK GROUP\n` +
            `https://raw.githubusercontent.com/aiorbd-video/video/refs/heads/main/Allinonesocialvid/output.m3u8\n\n`;

        let totalEvents = 0;
        let skippedHidden = 0;
        let invalidEvents = 0;
        let expiredEvents = 0;
        let futureEvents = 0;
        let missingStreams = 0;
        let generatedStreams = 0;

        /*
         * Process every event from the API.
         */
        for (const item of eventsData) {
            const event = item?.event;

            if (!event) {
                continue;
            }

            totalEvents++;

            /*
             * Skip events explicitly marked invisible.
             */
            if (event.visible === false) {
                skippedHidden++;
                continue;
            }

            const start = getEventStart(event);
            const end = getEventEnd(event);

            /*
             * If the event's date/time cannot be understood,
             * do not put it into the playlist.
             */
            if (!start || !end) {
                invalidEvents++;

                console.log(
                    `Invalid date/time: ${
                        event.eventName || "Unknown Event"
                    }`
                );

                continue;
            }

            /*
             * EVENT HAS ENDED
             *
             * This is the important stale-event check.
             */
            if (end <= now) {
                expiredEvents++;

                console.log(
                    `Expired: ${
                        event.eventName || "Unknown Event"
                    }`
                );

                continue;
            }

            /*
             * EVENT IS TOO FAR IN THE FUTURE
             *
             * Events beginning more than 24 hours from now
             * are not added yet.
             */
            if (start > upcomingLimit) {
                futureEvents++;

                console.log(
                    `Too far ahead: ${
                        event.eventName || "Unknown Event"
                    }`
                );

                continue;
            }

            /*
             * Find the matching stream database entry.
             */
            const slug = getSlug(event);

            if (
                !slug ||
                !streamsData[slug] ||
                !Array.isArray(streamsData[slug].streams)
            ) {
                missingStreams++;

                console.log(
                    `No stream data for: ${
                        event.eventName || "Unknown Event"
                    }`
                );

                continue;
            }

            /*
             * Event metadata.
             */
            const category =
                event.category || "Live Sports";

            const eventName =
                event.eventName || "Live Event";

            const teamA =
                event.teamAName || "";

            const teamB =
                event.teamBName || "";

            const logo =
                event.eventLogo || "";

            let matchTitle = eventName;

            if (teamA && teamB) {
                matchTitle +=
                    ` (${teamA} vs ${teamB})`;
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
                    continue;
                }

                /*
                 * Normalize headers after the "|".
                 *
                 * Example:
                 * https://example.com/stream.m3u8|user-agent=...
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
                 * Preserve the repository's existing
                 * stream DRM metadata.
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
            }
        }

        /*
         * ALWAYS overwrite playlist.m3u.
         *
         * This guarantees that events removed by the API's
         * current data do not remain from an older generated file.
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
            `Total API events: ${totalEvents}`
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
