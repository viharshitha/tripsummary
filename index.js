import { AzureOpenAI } from "openai";

const client = new AzureOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  apiVersion: process.env.OPENAI_API_VERSION,
  endpoint: process.env.OPENAI_ENDPOINT,
  deployment: process.env.OPENAI_DEPLOYMENT_ID
});

export default async function (context, req) {
  const tripData = req.body;

  console.log("Received payload:", tripData);
  console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "Present" : "Missing");
  console.log("OPENAI_ENDPOINT:", process.env.OPENAI_ENDPOINT ? "Present" : "Missing");
  console.log("OPENAI_DEPLOYMENT_ID:", process.env.OPENAI_DEPLOYMENT_ID || "Missing");
  console.log("OPENAI_API_VERSION:", process.env.OPENAI_API_VERSION || "Missing");

  if (!tripData || Object.keys(tripData).length === 0) {
    context.res = {
      status: 400,
      body: { error: "Missing or empty trip data in request body." }
    };
    return;
  }

  const prompt = `
You are a trip analysis assistant. Based on the following trip data, generate:
1. A concise summary of the trip.
2. 3–5 actionable suggestions to improve future trips.

Trip Data:
${JSON.stringify(tripData, null, 2)}
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
    console.error("OpenAI error:", error);
    context.res = {
      status: 500,
      body: {
        error: error.message,
        details: error.response?.data || null
      }
    };
  }
}
