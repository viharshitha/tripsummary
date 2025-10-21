import { AzureOpenAI } from "openai";

const client = new AzureOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  apiVersion: process.env.OPENAI_API_VERSION,
  endpoint: process.env.OPENAI_ENDPOINT,
  deployment: process.env.OPENAI_DEPLOYMENT_ID
});

export default async function (context, req) {
  try {
    const { destination, duration, interests } = req.body;

    if (!destination || !duration || !interests || !Array.isArray(interests)) {
      context.res = {
        status: 400,
        body: { error: "Missing or invalid input. Provide destination, duration, and interests array." }
      };
      return;
    }

    const prompt = `Plan a ${duration} trip to ${destination} focused on ${interests.join(", ")}. Include a summary and 3 suggestions.`;

    const response = await client.chat.completions.create({
      messages: [
        { role: "system", content: "You are a helpful travel planner." },
        { role: "user", content: prompt }
      ],
      max_tokens: 1024,
      temperature: 0.7
    });

    const content = response.choices[0].message.content;

    context.res = {
      status: 200,
      body: { summary: content }
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
