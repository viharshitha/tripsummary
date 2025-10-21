import { AzureOpenAI } from "openai";

const client = new AzureOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  apiVersion: process.env.OPENAI_API_VERSION,
  endpoint: process.env.OPENAI_ENDPOINT,
  deployment: process.env.OPENAI_DEPLOYMENT_ID
});

export default async function (context, req) {
  const tripData = req.body;

  if (!tripData || !tripData.destination || !tripData.duration || !Array.isArray(tripData.interests)) {
    context.res = {
      status: 400,
      body: { error: "Missing destination, duration, or interests in request body." }
    };
    return;
  }

  const prompt = `
You are a trip analysis assistant. Based on the following trip data, generate:
1. A concise summary of the trip.
2. 3–5 actionable suggestions to improve future trips.

Trip Data:
Destination: ${tripData.destination}
Duration: ${tripData.duration}
Interests: ${tripData.interests.join(", ")}
`;

  try {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 1024
    });

    const result = response.choices[0].message.content;

    const [summaryPart, suggestionsPart] = result.split(/Suggestions:/i);
    const suggestions = suggestionsPart
      ?.split(/\n+/)
      .filter((s) => s.trim())
      .map((s) => s.replace(/^\d+[\.\)]?\s*/, ""));

    context.res = {
      status: 200,
      body: {
        summary: summaryPart?.trim(),
        suggestions: suggestions || []
      }
    };
  } catch (error) {
    context.res = {
      status: 500,
      body: {
        error: error.message,
        details: error.response?.data || null
      }
    };
  }
}
