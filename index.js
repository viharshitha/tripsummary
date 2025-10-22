import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: `${process.env.OPENAI_ENDPOINT}/openai/deployments/${process.env.OPENAI_DEPLOYMENT_ID}`,
  defaultQuery: { "api-version": process.env.OPENAI_API_VERSION }
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

console.log("Calling OpenAI with:");
console.log("baseURL:", `${process.env.OPENAI_ENDPOINT}/openai/deployments/${process.env.OPENAI_DEPLOYMENT_ID}`);
console.log("apiKey:", process.env.OPENAI_API_KEY ? "Present" : "Missing");
console.log("apiVersion:", process.env.OPENAI_API_VERSION);
console.log("deployment:", process.env.OPENAI_DEPLOYMENT_ID);


  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_DEPLOYMENT_ID,
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
