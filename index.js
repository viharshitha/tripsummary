import sql from "mssql";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: `${process.env.OPENAI_ENDPOINT}/openai/deployments/${process.env.OPENAI_DEPLOYMENT_ID}`,
  defaultQuery: { "api-version": process.env.OPENAI_API_VERSION },
});

export default async function (context, req) {
  try {
    const {
      tripDetails,
      sensorDetails,
      tripPreferences,
      zoneProducts,
      excursionsList,
      segments,
    } = req.body;

    // Trip DB config
    const tripConfig = {
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      server: process.env.SQL_SERVER,
      database: process.env.TRIP_DB, // e.g. "RealTime.Trip"
      options: { encrypt: true, trustServerCertificate: false },
      port: 1433,
    };

    // Admin DB config
    const adminConfig = {
      ...tripConfig,
      database: process.env.RULES_DB, // e.g. "RealTime.Admin"
    };

    let poolTrip, poolAdmin, programId;
    programId = tripDetails.programId;

    // Connect to both DBs
    poolTrip = await new sql.ConnectionPool(tripConfig).connect();
    poolAdmin = await new sql.ConnectionPool(adminConfig).connect();

    if (!tripDetails || !sensorDetails?.length || !tripPreferences) {
      context.res = {
        status: 400,
        body: { error: "Missing required trip, sensor, or preference data." },
      };
      return;
    }

    const sensor = sensorDetails[0];
    const zone = zoneProducts?.[0] || {};
    // const preferredTempUnit = tripPreferences?.temperatureUnit?.unit || "°F";
    const location = tripDetails?.tripRecentData?.address || "Unknown location";
    const tripID = tripDetails.tripID;

    const eta = tripDetails?.tripETA
      ? new Date(tripDetails.tripETA).toLocaleString("en-US", {
          timeZone: "UTC",
        })
      : "Not available";

    const arrivalTime = tripDetails?.tripActualArrivalTime
      ? new Date(tripDetails.tripActualArrivalTime).toLocaleString("en-US", {
          timeZone: "UTC",
        })
      : "Not available";

    const productLabel = zone.productName || "Unknown Product";

    // --- Helpers ---
    const toCelsius = (f) => ((f - 32) * 5) / 9;

    const avg = (arr) =>
      arr.length
        ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)
        : "N/A";

    const excursionDuration = (count) => count * 5;

    const extractValues = (data) =>
      data
        ?.map((d) => (typeof d.value === "number" ? d.value : null))
        .filter((v) => v !== null) || [];

    const formatValue = (value, preferredUnit) => {
      if (value == null || value === "N/A") return "N/A";
      if (preferredUnit === "°C") return `${toCelsius(value).toFixed(1)}°C`;
      return `${parseFloat(value).toFixed(1)}°F`;
    };

    // --- Setup ---
    let totalExcursions = 0;
    let totalExcursionMinutes = 0;
    let criticalExcursions = 0;
    let warningExcursions = 0;

    const preferredTempUnit = tripPreferences?.temperatureUnit?.unit || "°F";

    const sensors = [
      {
        type: "Temperature",
        data: sensor.temperatureData,
        thresholds: {
          min: zone.minTemperature,
          max: zone.maxTemperature,
          min2: zone.min2Temperature,
          max2: zone.max2Temperature,
          ideal: zone.idealTemperature,
        },
        unit: preferredTempUnit,
        isTemp: true,
      },
      {
        type: "Humidity",
        data: sensor.humidityData,
        thresholds: {
          min: zone.minHumidity,
          max: zone.maxHumidity,
          min2: zone.min2Humidity,
          max2: zone.max2Humidity,
          ideal: zone.idealHumidity,
        },
        unit: tripPreferences?.humidityUnit?.unit || "%",
        isTemp: false,
      },
      {
        type: "Light",
        data: sensor.lightData,
        thresholds: {
          min: zone.minLight,
          max: zone.maxLight,
          min2: zone.min2Light,
          max2: zone.max2Light,
          ideal: zone.idealLight,
        },
        unit: tripPreferences?.lightUnit?.unit || "lux",
        isTemp: false,
      },
      {
        type: "CO₂",
        data: sensor.co2Data,
        thresholds: {
          min: zone.minCO2,
          max: zone.maxCO2,
          min2: zone.min2CO2,
          max2: zone.max2CO2,
          ideal: zone.idealCO2,
        },
        unit: tripPreferences?.cO2Unit?.unit || "ppm",
        isTemp: false,
      },
    ];

    // --- Excursion Detection ---
    const sensorSummaries = sensors.map(
      ({ type, data, thresholds, unit, isTemp }) => {
        const values = extractValues(data); // always °F internally
        const averageF = avg(values); // average in °F
        if (values.length === 0) return `${type}: data unavailable`;

        const { min, max, min2, max2, ideal } = thresholds;

        let warnings = 0;
        let criticals = 0;

        values.forEach((v) => {
          if (min2 != null && v < min2) criticals++;
          else if (min != null && v < min) warnings++;

          if (max2 != null && v > max2) criticals++;
          else if (max != null && v > max) warnings++;
        });

        const excursions = warnings + criticals;
        totalExcursions += excursions;
        totalExcursionMinutes += excursionDuration(excursions);
        criticalExcursions += criticals;
        warningExcursions += warnings;

        const excursionText =
          excursions === 0
            ? "No excursions in past 12h"
            : `${criticals} critical, ${warnings} warning excursions (${excursionDuration(
                excursions
              )} min)`;

        const avgDisplay = isTemp
          ? formatValue(averageF, unit)
          : `${averageF}${unit}`;
        const idealDisplay =
          isTemp && ideal != null ? formatValue(ideal, unit) : ideal;

        const idealText = idealDisplay
          ? `Ideal: ${idealDisplay}`
          : "Ideal not defined";

        return `${type}: avg ${avgDisplay}, ${excursionText}. ${idealText}`;
      }
    );

    // --- After sensorSummaries.map(...) finishes ---
    const overallExcursionSummary =
      totalExcursions === 0
        ? "No excursions detected in the past 12 hours."
        : `Overall: ${criticalExcursions} critical and ${warningExcursions} warning excursions across all sensors, totaling ${totalExcursionMinutes} minutes.`;

    // --- Excursion Summary ---
    const excursionNames = excursionsList?.map((e) => e.excursionName) || [];
    const excursionSummary = excursionNames.length
      ? `${excursionNames.length} excursions recorded — ${excursionNames.join(
          ", "
        )}`
      : "No excursions recorded";

    for (const exc of excursionsList) {
      const enriched = await enrichExcursion(
        exc,
        poolTrip,
        poolAdmin,
        programId
      );
      enrichedExcursions.push(enriched);
    }
    async function enrichExcursion(exc, poolTrip, poolAdmin, programId) {
      const histRequest = poolTrip.request();
      histRequest.input("programId", sql.Int, programId);
      histRequest.input("locationAddress", sql.NVarChar, exc.LocationAddress);
      histRequest.input("alarmTypeId", sql.Int, exc.AlarmTypeId);

      const histResult = await histRequest.query(`
    SELECT TOP 1 te.EventReasons, COUNT(*) AS MatchCount
    FROM dbo.TripExcursion te
    JOIN dbo.Shipment s ON s.Id = te.TripId
    WHERE s.ProgramId = @programId
      AND te.LocationAddress = @locationAddress
      AND te.AlarmTypeId = @alarmTypeId
      AND te.EventReasons IS NOT NULL AND te.EventReasons <> ''
      AND te.Disabled = 0
    GROUP BY te.EventReasons
    ORDER BY MatchCount DESC
  `);

      let reasonId = null,
        reasonName = null,
        comment = null,
        confidence = "Low";

      if (histResult.recordset.length > 0) {
        const rawReason = histResult.recordset[0].EventReasons;
        const count = histResult.recordset[0].MatchCount;
        const ids = rawReason
          .split(",")
          .map((x) => parseInt(x.trim(), 10))
          .filter((x) => !Number.isNaN(x));
        if (ids.length > 0) {
          reasonId = ids[0];
          const adminRequest = poolAdmin.request();
          adminRequest.input("reasonId", sql.Int, reasonId);
          adminRequest.input("programId", sql.Int, programId);
          const reasonLookup = await adminRequest.query(`
        SELECT Name FROM dbo.AcknowledgementReasonDefinition
        WHERE AcknowledgementReasonDefinitionId = @reasonId AND ProgramId = @programId AND Enabled = 1
      `);
          reasonName = reasonLookup.recordset[0]?.Name || "Unknown Reason";

          const prompt = `Generate a short QA comment for alarm '${exc.ExcursionName}' at location '${exc.LocationAddress}'. Historical data shows ${count} past alarms at this location with reason: '${reasonName}'. Write a professional comment that explains this is a recurring pattern.`;

          const response = await openai.chat.completions.create({
            model: process.env.OPENAI_DEPLOYMENT_ID,
            messages: [
              {
                role: "system",
                content: "You are a helpful assistant that writes QA comments.",
              },
              { role: "user", content: prompt },
            ],
            max_tokens: 100,
          });

          comment = response.choices[0].message.content.trim();
          confidence = "High";
        }
      }

      return {
        ...exc,
        suggestedReasonId: reasonId,
        suggestedReasonName: reasonName,
        comment,
        confidence,
        feedbackRequired: true,
        commentId: Math.floor(Math.random() * 1000000),
      };
    }

    const segmentSummary = segments?.length
      ? segments
          .map((s, i) => {
            const name = s.segmentName || `Segment ${i + 1}`;
            const status = s.segmentStatus || "Unknown";
            const excursionCount = s.excursions?.length || 0;
            return `- ${name}: Status - ${status}, Excursions - ${excursionCount}`;
          })
          .join("\n")
      : "No segment data available.";

    // --- ETA Prediction ---
    let tripStartTime = null;

    if (tripDetails.tripStart?.tripStartedTime) {
      tripStartTime = new Date(tripDetails.tripStart.tripStartedTime);
    } else if (tripDetails.tripOrigin?.actualDepartureTime) {
      tripStartTime = new Date(tripDetails.tripOrigin.actualDepartureTime);
    } else if (segments?.[0]?.segmentStartTime) {
      tripStartTime = new Date(segments[0].segmentStartTime);
    } else if (tripDetails.destinations?.[0]?.arrivalTime) {
      tripStartTime = new Date(tripDetails.destinations[0].arrivalTime);
    } else {
      tripStartTime = new Date(tripDetails.createDate || Date.now());
    }

    const completedSegments = segments.filter(
      (s) => s.segmentStatus === "Completed"
    );
    const remainingSegments = segments.filter(
      (s) => s.segmentStatus !== "Completed"
    );

    const avgSegmentDurationMs = completedSegments.length
      ? completedSegments.reduce((sum, s) => {
          const start = new Date(s.segmentStartTime).getTime();
          const end = new Date(s.segmentEndTime).getTime();
          return sum + (end - start);
        }, 0) / completedSegments.length
      : 45 * 60 * 1000; // default 45 mins

    const estimatedRemainingMs =
      avgSegmentDurationMs * remainingSegments.length;

    const stopDelayMs =
      tripDetails.destinations?.reduce((sum, d) => {
        const start = new Date(d.arrivalTime || d.startTime || 0).getTime();
        const end = new Date(d.departureTime || d.endTime || 0).getTime();
        return sum + (end > start ? end - start : 0);
      }, 0) || 0;

    const bufferMs =
      (criticalExcursions * 30 + warningExcursions * 10) * 60 * 1000;

    const predictedETA = new Date(
      tripStartTime.getTime() + estimatedRemainingMs + stopDelayMs + bufferMs
    );

    const formattedETA = predictedETA.toLocaleString("en-US", {
      timeZone: "UTC",
    });

    // --- Confidence ---
    let confidence = "High";
    if (criticalExcursions > 0 || warningExcursions > 2)
      confidence = "Moderate";
    if (totalExcursionMinutes > 60 || remainingSegments.length > 2)
      confidence = "Low";

    // --- Risk Scoring ---
    let score = 0;
    if (criticalExcursions > 0) score += 2;
    if (warningExcursions > 0) score += 1;
    if (totalExcursionMinutes > 30) score += 1;
    if (
      excursionNames.some((name) =>
        name.toLowerCase().includes("new product alarm")
      )
    )
      score += 2;
    if (
      zone.productName?.toLowerCase().includes("vaccine") ||
      zone.productName?.toLowerCase().includes("frozen")
    )
      score += 1;

    const now = Date.now();
    const recentExcursions =
      excursionsList?.filter((e) => {
        const ts = new Date(
          e.timestamp || e.time || e.eventTime || 0
        ).getTime();
        return now - ts <= 12 * 60 * 60 * 1000;
      }) || [];
    if (recentExcursions.length > 0) score += 1;

    let riskLevel = "Low";
    if (score >= 3) riskLevel = "Moderate";
    if (score >= 5) riskLevel = "High";

    // --- Final Outputs ---
    console.log("Sensor Summaries:", sensorSummaries);
    console.log("Excursion Summary:", excursionSummary);
    console.log("Segment Summary:", segmentSummary);
    console.log("Predicted ETA:", formattedETA, "Confidence:", confidence);
    console.log("Risk Level:", riskLevel);

    const prompt = `
You are an AI shipment analyst. Based on the structured data below, generate a concise, human-readable summary of the shipment's current state.

Important: Always follow this exact order in your response. Do not change the sequence.

Match the tone and structure of these examples:

✅ “Shipment #SEN-2345 carrying frozen seafood is stable. Average temperature: -18.1°C (within threshold). No excursions detected in the past 12 hours. ETA: 4 hours. Risk level: Low.”

⚠️ “Shipment #SEN-4579 shows temperature excursion above 8°C for 45 minutes. Cooling restored after door closure. Recommend QA inspection upon arrival. Risk level: Moderate.”

Use this format:
- Start with shipment ID and product
- Sensor performance (temperature, humidity, light, CO₂)
- Mention if it’s stable or risky
- Include average temperature and excursion context
- Mention ETA and arrival time
- Location of the container
- End with risk level (Low, Moderate, High) and 2 actionable recommendations for QA or operations

Shipment Metadata:
- ID: ${tripID}
- Product: ${productLabel}
- Location: ${location}
- ETA: ${eta}
- Actual Arrival Time: ${arrivalTime}
- Predicted ETA: ${formattedETA} (Confidence: ${confidence})
- Risk Level: ${riskLevel}

Sensor Performance:
${sensorSummaries.join("\n")}

Excursion Summary:
${overallExcursionSummary}
${excursionSummary}
${enrichedExcursions
  .map(
    (e) =>
      `• ${e.excursionName} at ${e.locationAddress}: ${
        e.comment || "No historical pattern found."
      } (Confidence: ${e.confidence})`
  )
  .join("\n")}

Segment Breakdown:
${segmentSummary}

Recent Excursions (last 12h): ${recentExcursions.length}
`;

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_DEPLOYMENT_ID,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5,
      max_tokens: 512,
    });

    const summary = response.choices[0].message.content;

    context.res = {
      status: 200,
      body: { summary },
    };
  } catch (error) {
    console.error("❌ OpenAI call failed:", {
      message: error.message,
      stack: error.stack,
      response: error.response?.data,
    });

    context.res = {
      status: 500,
      body: {
        error: error.message || "Unknown error",
        stack: error.stack || "No stack trace",
        response: error.response?.data || "No response data",
      },
    };
  }
}
