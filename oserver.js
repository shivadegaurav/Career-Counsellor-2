require("dotenv").config()
const express = require("express")
const path = require("path")
const jwt = require("jsonwebtoken")
const bcrypt = require("bcryptjs")
const cookieParser = require("cookie-parser")
const cors = require("cors")
const multer = require("multer")
const pdf = require("pdf-parse")
const fs = require("fs").promises
const axios = require("axios") // Add axios for HTTP requests to Ollama API
const mongoose = require("mongoose")

const app = express()

// ------------------------------
// MongoDB Connection & Schemas
// ------------------------------
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => {
    console.error("MongoDB connection error:", err)
    process.exit(1)
  })

/* 
  User Schema  
  - email is unique and serves as the primary identifier.
*/
const UserSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
  },
  { timestamps: true },
)
const UserModel = mongoose.model("User", UserSchema)

// All other schemas store the user's email as reference.

const ChatHistorySchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  messages: [
    {
      role: String,
      content: String,
      timestamp: { type: Date, default: Date.now },
    },
  ],
})
const ChatHistoryModel = mongoose.model("ChatHistory", ChatHistorySchema)

const IQAssessmentSchema = new mongoose.Schema({
  email: { type: String, required: true },
  age: Number,
  score: Number,
  calculatedIQ: Number,
  interpretation: String,
  timestamp: { type: Date, default: Date.now },
})
const IQAssessmentModel = mongoose.model("IQAssessment", IQAssessmentSchema)

const PersonalityAssessmentSchema = new mongoose.Schema({
  email: { type: String, required: true },
  age: Number,
  traitScores: mongoose.Schema.Types.Mixed,
  interpretation: mongoose.Schema.Types.Mixed, // This will store both trait percentages and description
  timestamp: { type: Date, default: Date.now },
})
const PersonalityAssessmentModel = mongoose.model("PersonalityAssessment", PersonalityAssessmentSchema)

const ResumeAnalysisSchema = new mongoose.Schema({
  email: { type: String, required: true },
  originalText: String,
  rawAnalysis: String,
  sections: mongoose.Schema.Types.Mixed,
  timestamp: { type: Date, default: Date.now },
})
const ResumeAnalysisModel = mongoose.model("ResumeAnalysis", ResumeAnalysisSchema)

// ------------------------------
// Global Middlewares
// ------------------------------
app.use(cors())
app.use(express.json())
app.use(cookieParser())
app.use(express.static(path.join(__dirname, "public")))

// ------------------------------
// Check Environment Variables
// ------------------------------
if (!process.env.OLLAMA_BASE_URL) {
  console.error("Error: OLLAMA_BASE_URL is not set in environment variables")
  console.error("Example: OLLAMA_BASE_URL=http://localhost:11434")
  process.exit(1)
}

// ------------------------------
// Initialize Ollama Client
// ------------------------------
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL
// Default model to use - can be configured in .env
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3"

// Helper function for Ollama API requests
async function callOllama(prompt, options = {}) {
  const { model = OLLAMA_MODEL, stream = false, temperature = 0.7, system = "", context = null } = options

  try {
    const endpoint = stream ? "generate" : "generate"
    const response = await axios.post(`${OLLAMA_BASE_URL}/api/${endpoint}`, {
      model,
      prompt,
      stream,
      temperature,
      system,
      context,
    })

    return response.data
  } catch (error) {
    console.error("Ollama API Error:", error.response?.data || error.message)
    throw new Error(`Ollama API Error: ${error.message}`)
  }
}

// Helper function for streaming responses
async function streamOllama(prompt, res, options = {}) {
  try {
    const response = await axios.post(
      `${OLLAMA_BASE_URL}/api/generate`,
      {
        model: options.model || OLLAMA_MODEL,
        prompt,
        stream: true,
        temperature: options.temperature || 0.7,
        system: options.system || "",
      },
      {
        responseType: "stream",
      },
    )

    let fullResponse = ""

    response.data.on("data", (chunk) => {
      try {
        const lines = chunk
          .toString()
          .split("\n")
          .filter((line) => line.trim())
        for (const line of lines) {
          const data = JSON.parse(line)
          if (data.response) {
            fullResponse += data.response
            res.write(`data: ${JSON.stringify({ text: data.response })}\n\n`)
          }
          if (data.done) {
            res.write("data: [DONE]\n\n")
            res.end()
            return fullResponse
          }
        }
      } catch (e) {
        console.error("Error parsing stream chunk:", e)
      }
    })

    response.data.on("error", (error) => {
      console.error("Stream error:", error)
      res.write(`data: ${JSON.stringify({ error: "Stream error occurred" })}\n\n`)
      res.end()
    })
  } catch (error) {
    console.error("Streaming error:", error)
    res.write(`data: ${JSON.stringify({ error: "Failed to stream response" })}\n\n`)
    res.end()
  }
}

// JWT secret (for demo purposes only; store securely in production)
const JWT_SECRET = "your-secret-key"

// ================================
// AUTH & USER ROUTES
// ================================
app.get("/feedback", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "feedback.html"))
})

app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"))
})
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"))
})

app.post("/auth/register", async (req, res) => {
  const fullName = req.body.fullName || req.body.name
  const { email, password } = req.body
  if (!fullName || !email || !password) {
    return res.status(400).json({ message: "Full name, email, and password are required" })
  }
  try {
    const existingUser = await UserModel.findOne({ email })
    if (existingUser) {
      return res.status(400).json({ message: "Email already registered" })
    }
    const hashedPassword = bcrypt.hashSync(password, 10)
    const newUser = await UserModel.create({ fullName, email, password: hashedPassword })
    const token = jwt.sign({ email, fullName }, JWT_SECRET, { expiresIn: "24h" })
    res.status(201).json({ token, user: { fullName, email } })
  } catch (error) {
    console.error("Registration error:", error)
    res.status(500).json({ message: "Internal server error" })
  }
})

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body
  try {
    const user = await UserModel.findOne({ email })
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ message: "Invalid credentials" })
    }
    const token = jwt.sign({ email, fullName: user.fullName }, JWT_SECRET, { expiresIn: "24h" })
    res.json({ token, user: { fullName: user.fullName, email } })
  } catch (error) {
    console.error("Login error:", error)
    res.status(500).json({ message: "Internal server error" })
  }
})

// Authentication middleware for protected endpoints.
const authenticateUser = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1]
  if (!token) return res.status(401).json({ message: "Authentication required" })
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    req.user = decoded // Contains email and fullName.
    next()
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" })
  }
}

// Optional authentication middleware - allows both authenticated and guest users
const optionalAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1]
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET)
      req.user = decoded
    } catch (error) {
      req.user = null
    }
  } else {
    req.user = null
  }
  next()
}

// ------------------------------
// Validate Age Middleware
// ------------------------------
// Defaults to age 30 if not provided.
const validateAge = (req, res, next) => {
  let age = Number.parseInt(req.query.age || req.body.age)
  if (!age) age = 30
  if (age < 5 || age > 120) {
    return res.status(400).json({ error: "Invalid age. Must be between 5 and 120." })
  }
  req.validatedAge = age
  next()
}

// ------------------------------
// Profile Endpoint - FIXED
// ------------------------------
app.get("/api/profile", authenticateUser, async (req, res) => {
  try {
    const user = await UserModel.findOne({ email: req.user.email }).lean()
    if (!user) return res.status(404).json({ error: "User not found" })

    const iqAssessment = await IQAssessmentModel.findOne({ email: user.email }).sort({ timestamp: -1 }).lean()
    const personalityAssessment = await PersonalityAssessmentModel.findOne({ email: user.email })
      .sort({ timestamp: -1 })
      .lean()
    const resumeAnalysis = await ResumeAnalysisModel.findOne({ email: user.email }).sort({ timestamp: -1 }).lean()
    const chatHistory = await ChatHistoryModel.find({ email: user.email }).lean()

    // Fix personality assessment data structure
    let formattedPersonalityAssessment = null
    if (personalityAssessment && personalityAssessment.traitScores) {
      formattedPersonalityAssessment = {
        ...personalityAssessment,
        // Create interpretation object with trait percentages for frontend
        interpretation: {
          extraversion: personalityAssessment.traitScores.extraversion || 0,
          agreeableness: personalityAssessment.traitScores.agreeableness || 0,
          conscientiousness: personalityAssessment.traitScores.conscientiousness || 0,
          neuroticism: personalityAssessment.traitScores.neuroticism || 0,
          openness: personalityAssessment.traitScores.openness || 0,
        },
      }
    }

    res.json({
      fullName: user.fullName,
      email: user.email,
      memberSince: user.createdAt,
      iqAssessment,
      personalityAssessment: formattedPersonalityAssessment,
      resumeAnalysis,
      chatHistory,
    })
  } catch (err) {
    console.error("Profile fetch error:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})

app.get("/profile", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "profile.html"))
})

// ================================
// CAREER COUNSELING & CHAT ROUTES
// ================================

app.post("/chat", authenticateUser, async (req, res) => {
  try {
    const { message, sessionId } = req.body
    if (!sessionId || !message) return res.status(400).json({ error: "Session ID and message are required" })

    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")

    const chatRecord = await ChatHistoryModel.findOne({ sessionId })
    const history = chatRecord ? chatRecord.messages : []

    if (!history.length) {
      const initialMessage = {
        role: "assistant",
        content: `Your name is Jessica.
You are a professional career counseling assistant who provides personalized advice based on a user's interests, strengths, weaknesses, hobbies, and personality traits.
First, ask the user to select their preferred language (English, मराठी, or हिंदी). Do not respond directly in any language unless the user mentions it. If no language is specified, respond in English.
Provide career suggestions based on the Indian education system.
Tone and Approach:
Maintain a conversational, empathetic tone, ensuring users feel comfortable sharing their thoughts.
Offer insights in a positive, non-judgmental manner. Avoid going outside the domain of career counseling and focus on career-related topics only.
Language Selection:

Start by asking: "Please select your preferred language: English, मराठी, or हिंदी?"
Continue the conversation in the chosen language. If no preference is mentioned, default to English.
Questioning Strategy:

Ask one question at a time. Keep responses short, and avoid giving explanations for the questions or answers during the interaction.
Ask a minimum of 15 questions before providing career suggestions.
Ask for the user's name and educational background as compulsory information, but do not begin with educational background questions. First, try to understand the personality and preferences of the user by asking small, engaging questions about their interests, strengths, and personality traits.`,
        timestamp: new Date(),
      }
      history.push(initialMessage)
    }

    try {
      // Format history for Ollama
      const formattedHistory = history
        .map((msg) => {
          return `${msg.role === "user" ? "Human: " : "Assistant: "}${msg.content}\n`
        })
        .join("\n")

      // Current message from user
      const fullPrompt = `${formattedHistory}\nHuman: ${message}\nAssistant:`

      // Stream the response
      const fullResponse = await streamOllama(fullPrompt, res, {
        temperature: 0.7,
        system:
          "You are Jessica, a professional career counseling assistant. Follow the instructions given in the previous messages carefully.",
      })

      history.push({ role: "user", content: message, timestamp: new Date() })
      history.push({ role: "assistant", content: fullResponse, timestamp: new Date() })

      await ChatHistoryModel.findOneAndUpdate(
        { sessionId },
        { sessionId, email: req.user.email, messages: history },
        { upsert: true, new: true },
      )
    } catch (error) {
      console.error("Chat error:", error)
      if (error.message?.includes("connection")) {
        res.write(
          `data: ${JSON.stringify({ error: "Could not connect to Ollama API. Check your server configuration." })}\n\n`,
        )
      } else if (error.message?.includes("not found")) {
        res.write(
          `data: ${JSON.stringify({ error: "The requested model was not found. Make sure it's installed on your Ollama server." })}\n\n`,
        )
      } else {
        res.write(`data: ${JSON.stringify({ error: "An error occurred while processing your message." })}\n\n`)
      }
      res.end()
    }
  } catch (error) {
    console.error("Error:", error)
    res.write(`data: ${JSON.stringify({ error: "Failed to process message" })}\n\n`)
    res.end()
  }
})

app.post("/clear-chat", authenticateUser, async (req, res) => {
  const { sessionId } = req.body
  if (sessionId) await ChatHistoryModel.deleteOne({ sessionId })
  res.json({ message: "Chat history cleared" })
})

// ================================
// IQ TEST & PERSONALITY ANALYZER ROUTES
// ================================

// Updated parseQuestionResponse function to robustly extract JSON.
function parseQuestionResponse(responseText, type) {
  try {
    let cleaned = cleanResponse(responseText)
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch && jsonMatch[0]) {
      cleaned = jsonMatch[0].trim()
    }
    if (cleaned[cleaned.length - 1] !== "}") {
      cleaned += "}"
    }
    const parsed = JSON.parse(cleaned)
    if (type === "iq") {
      if (
        !parsed.text ||
        !parsed.options ||
        !Array.isArray(parsed.options) ||
        typeof parsed.correct !== "number" ||
        parsed.options.length !== 4 ||
        parsed.correct < 0 ||
        parsed.correct > 3
      ) {
        console.log("Invalid IQ question format, using fallback")
        return getRandomFallbackQuestion("iq")
      }
    } else if (type === "psychometric") {
      if (
        !parsed.text ||
        !parsed.options ||
        !Array.isArray(parsed.options) ||
        !parsed.trait ||
        parsed.options.length !== 4
      ) {
        console.log("Invalid psychometric question format, using fallback")
        return getRandomFallbackQuestion("psychometric")
      }
    }
    if (!isQuestionUnique(parsed, type)) {
      console.log("Duplicate question detected, using fallback")
      return getRandomFallbackQuestion(type)
    }
    return parsed
  } catch (error) {
    console.error("Parsing error:", error)
    return getRandomFallbackQuestion(type)
  }
}

function cleanResponse(text) {
  try {
    text = text.replace(/```json\s+/g, "").replace(/```\s*$/g, "")
    text = text.replace(/\s+/g, " ").trim()
    text = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")
    return text
  } catch (error) {
    console.error("Error in cleanResponse:", error)
    return ""
  }
}

function isQuestionUnique(question, type) {
  const questionHash = JSON.stringify(question)
  if (recentQuestionsCache[type].has(questionHash)) return false
  recentQuestionsCache[type].add(questionHash)
  return true
}

const fallbackQuestions = {
  iq: [
    {
      text: "What comes next in the sequence: 2, 4, 8, 16, __?",
      options: ["24", "32", "28", "20"],
      correct: 1,
    },
  ],
  psychometric: [
    {
      text: "How do you typically react to unexpected changes in your plans?",
      options: [
        "Embrace the change enthusiastically",
        "Adapt after initial hesitation",
        "Feel uncomfortable but manage",
        "Strongly prefer sticking to plans",
      ],
      trait: "openness",
    },
  ],
}

const recentQuestionsCache = {
  iq: new Set(),
  psychometric: new Set(),
}

setInterval(() => {
  recentQuestionsCache.iq.clear()
  recentQuestionsCache.psychometric.clear()
}, 1800000) // every 30 minutes

function getRandomFallbackQuestion(type) {
  return fallbackQuestions[type][Math.floor(Math.random() * fallbackQuestions[type].length)]
}

function getDifficultyLevel(age) {
  const difficultyLevels = {
    "5-7": { complexity: "very simple", topics: "basic pattern recognition, simple logic" },
    "8-10": { complexity: "simple", topics: "basic reasoning, pattern recognition, simple math" },
    "11-13": { complexity: "moderate", topics: "logical reasoning, spatial awareness, basic algebra" },
    "14-16": { complexity: "challenging", topics: "abstract reasoning, advanced logic, spatial puzzles" },
    "17-20": { complexity: "advanced", topics: "complex reasoning, mathematical logic, abstract problem solving" },
    "21-35": { complexity: "professional", topics: "advanced analytical reasoning, complex problem solving" },
    "36-50": { complexity: "expert", topics: "strategic reasoning, complex pattern recognition" },
    "51+": { complexity: "comprehensive", topics: "life experience, wisdom-based reasoning" },
  }
  for (const key in difficultyLevels) {
    if (key.includes("-")) {
      const [min, max] = key.split("-").map(Number)
      if (age >= min && age <= max) return difficultyLevels[key]
    } else if (key.includes("+")) {
      const min = Number(key.replace("+", ""))
      if (age >= min) return difficultyLevels[key]
    }
  }
  return difficultyLevels["21-35"]
}

app.get("/api/questions", validateAge, async (req, res) => {
  try {
    const age = req.validatedAge
    const type = req.query.type || "iq"
    const level = getDifficultyLevel(age)
    const randomSeed = Date.now()

    let prompt
    if (type === "iq") {
      prompt = `Create a single unique IQ test question in JSON format. Use this random seed for uniqueness: ${randomSeed}. 
Format: 
{
  "text": "What comes next in the sequence: 1, 2, 4, 8, ...?",
  "options": ["10", "12", "16", "14"],
  "correct": 2
}
Important: Ensure the question is new and suitable for age ${age} with complexity ${level.complexity}. Return only valid JSON.`
    } else {
      prompt = `Create a single unique personality assessment question in JSON format. Use this random seed for uniqueness: ${randomSeed}.
Format:
{
  "text": "How do you typically react to unexpected changes?",
  "options": ["Very positively", "Somewhat positively", "Somewhat negatively", "Very negatively"],
  "trait": "openness"
}
Important: Ensure the question is new and focuses on one of these traits: extraversion, agreeableness, conscientiousness, neuroticism, or openness. Return only valid JSON.`
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))

    try {
      const response = await callOllama(prompt, {
        temperature: 0.7,
        top_k: 40,
        top_p: 0.8,
      })
      const responseText = response.response
      const generatedQuestion = parseQuestionResponse(responseText, type)
      res.json(generatedQuestion || getRandomFallbackQuestion(type))
    } catch (error) {
      console.error("Question generation error:", error)
      res.json(getRandomFallbackQuestion(req.query.type || "iq"))
    }
  } catch (error) {
    console.error("Question generation error:", error)
    res.json(getRandomFallbackQuestion(req.query.type || "iq"))
  }
})

// IQ Test endpoint: Uses optional auth - works for both logged in and guest users
app.post("/api/calculate-iq", optionalAuth, validateAge, async (req, res) => {
  const { score } = req.body
  const email = req.user ? req.user.email : "guest"

  try {
    if (typeof score !== "number" || score < 0 || score > 10)
      return res.status(400).json({ error: "Score must be a number between 0 and 10" })

    const calculatedIQ = Math.round((score / 10) * 80 + 70)
    let interpretation

    if (calculatedIQ >= 130) {
      interpretation = "Very Superior Intelligence"
    } else if (calculatedIQ >= 120) {
      interpretation = "Superior Intelligence"
    } else if (calculatedIQ >= 110) {
      interpretation = "High Average Intelligence"
    } else if (calculatedIQ >= 90) {
      interpretation = "Average Intelligence"
    } else if (calculatedIQ >= 80) {
      interpretation = "Low Average Intelligence"
    } else {
      interpretation = "Below Average Intelligence"
    }

    const iqAssessment = new IQAssessmentModel({
      email,
      age: req.validatedAge,
      score,
      calculatedIQ,
      interpretation,
    })
    await iqAssessment.save()

    res.json({ iq: calculatedIQ, interpretation })
  } catch (error) {
    console.error("IQ calculation error:", error)
    res.status(500).json({ error: "Failed to calculate IQ" })
  }
})

// Personality Analysis endpoint: Protected - FIXED
app.post("/api/analyze-personality", authenticateUser, validateAge, async (req, res) => {
  const { answers } = req.body

  try {
    if (!answers || !Array.isArray(answers)) {
      return res.status(400).json({ error: "Answers array is required" })
    }

    const traitScores = {}

    // Calculate trait scores
    const traits = ["extraversion", "agreeableness", "conscientiousness", "neuroticism", "openness"]

    traits.forEach((trait) => {
      const traitAnswers = answers.filter((a) => a.trait === trait)
      if (traitAnswers.length > 0) {
        const averageSelected = traitAnswers.reduce((sum, a) => sum + a.selected, 0) / traitAnswers.length
        traitScores[trait] = Math.round(((3 - averageSelected) / 3) * 100)
      } else {
        traitScores[trait] = 50 // Default neutral score
      }
    })

    const prompt = `Given these Big Five personality scores: ${JSON.stringify(traitScores)},
provide a brief personality type description in JSON format with the following fields:
{"type":"primary personality type","description":"brief interpretation","strengths":["str1","str2"],"improvements":["imp1","imp2"]}
Return only valid JSON.`

    try {
      const response = await callOllama(prompt, {
        temperature: 0.3,
      })
      const responseText = response.response

      let parsedResponse
      try {
        parsedResponse = JSON.parse(cleanResponse(responseText))
      } catch (parseError) {
        // Fallback if AI response isn't valid JSON
        parsedResponse = {
          type: "Balanced Personality",
          description: "You show a well-rounded personality profile across all traits.",
          strengths: ["Adaptable", "Well-balanced"],
          improvements: ["Continue developing all areas", "Focus on specific strengths"],
        }
      }

      const personalityAssessment = new PersonalityAssessmentModel({
        email: req.user.email,
        age: req.validatedAge,
        traitScores,
        interpretation: parsedResponse,
      })
      await personalityAssessment.save()

      res.json({
        scores: traitScores,
        interpretation: parsedResponse,
        traitPercentages: traitScores, // Additional field for compatibility
      })
    } catch (error) {
      console.error("Personality analysis error:", error)
      res.status(500).json({ error: "Failed to analyze personality" })
    }
  } catch (error) {
    console.error("Personality analysis error:", error)
    res.status(500).json({ error: "Failed to analyze personality" })
  }
})

// ================================
// RESUME ANALYZER ROUTES - FIXED
// ================================
const uploadDir = path.join(__dirname, "uploads")

// Ensure upload directory exists
fs.mkdir(uploadDir, { recursive: true }).catch(console.error)

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now()
    const sanitizedFilename = file.originalname.replace(/\s+/g, "-")
    cb(null, `${timestamp}-${sanitizedFilename}`)
  },
})

const fileFilter = (req, file, cb) => {
  if (file.mimetype === "application/pdf") {
    cb(null, true)
  } else {
    cb(new Error("Only PDF files are allowed"), false)
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
})

async function analyzeWithOllama(text) {
  try {
    const prompt = `As an expert resume reviewer, please analyze the following resume text and provide detailed, actionable feedback. Format your response in clearly separated sections with headings.

**1. Format and Layout:**
- Evaluate the visual organization and consistency in formatting.
- Assess the use of white space and overall readability.

**2. Content Quality:**
- Analyze the clarity and effectiveness of the experience descriptions.
- Provide insights on achievement quantification and use of action verbs.

**3. Skills and Qualifications:**
- Evaluate how technical and soft skills are presented.
- Comment on the relevance of the skills to current industry standards.

**4. Areas for Improvement:**
- Identify any missing or weak sections in the resume.
- Suggest specific enhancements for a stronger impact.

**5. Key Recommendations:**
- List the top actionable suggestions for improvement.
- Provide advice on incorporating modern resume trends.

Resume Text:
${text}`

    try {
      const response = await callOllama(prompt, {
        temperature: 0.3,
        num_predict: 2048,
      })
      return response.response.trim()
    } catch (error) {
      console.error("Ollama API Error:", error)
      throw new Error("Failed to analyze the resume using AI.")
    }
  } catch (error) {
    console.error("Ollama API Error:", error)
    throw new Error("Failed to analyze the resume using AI.")
  }
}

function parseAnalysis(analysisText) {
  const regex = /\*\*(\d+\.\s*[^*]+):\*\*\n([\s\S]*?)(?=\n\*\*\d+\.\s*[^*]+:\*\*|$)/g
  const sections = {}
  let match
  while ((match = regex.exec(analysisText)) !== null) {
    const heading = match[1].trim()
    const content = match[2].trim()
    sections[heading] = content
  }
  return sections
}

// Resume analysis endpoint - FIXED with proper authentication
app.post("/analyze", optionalAuth, upload.single("resume"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF file uploaded." })

  try {
    const dataBuffer = await fs.readFile(req.file.path)
    const data = await pdf(dataBuffer)
    const text = data.text

    if (!text || !text.trim()) {
      throw new Error("No text could be extracted from the PDF.")
    }

    const analysis = await analyzeWithOllama(text)
    const parsedAnalysis = parseAnalysis(analysis)

    const email = req.user ? req.user.email : "guest"

    const resumeAnalysis = new ResumeAnalysisModel({
      email,
      originalText: text,
      rawAnalysis: analysis,
      sections: parsedAnalysis,
    })
    await resumeAnalysis.save()

    res.json({
      rawAnalysis: analysis,
      sections: parsedAnalysis,
      success: true,
      message: "Resume analyzed successfully",
    })
  } catch (error) {
    console.error("Analysis Error:", error)
    res.status(500).json({ error: error.message })
  } finally {
    // Clean up uploaded file
    if (req.file && req.file.path) {
      try {
        await fs.unlink(req.file.path)
      } catch (unlinkError) {
        console.error("Error deleting file:", unlinkError)
      }
    }
  }
})

// Multer error handling middleware.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File size exceeds 5MB limit." })
    }
    return res.status(400).json({ error: err.message })
  }
  if (err.message === "Only PDF files are allowed") {
    return res.status(400).json({ error: "Only PDF files are allowed." })
  }
  next(err)
})

// ================================
// ADDITIONAL UTILITY ROUTES
// ================================

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() })
})

// Serve static files for different routes
app.get("/iqtest", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "iqtest.html"))
})

app.get("/resume", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "resume.html"))
})

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landindex.html"))
})

// ================================
// ERROR HANDLING MIDDLEWARE
// ================================

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err)
  res.status(500).json({ error: "Internal server error" })
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" })
})

//--------session error personality
async function fixPersonalityAssessmentIndexes() {
  try {
    // Drop the problematic index
    await PersonalityAssessmentModel.collection.dropIndex("sessionId_1")
    console.log("Dropped sessionId index from personality assessments")
  } catch (error) {
    if (error.code === 27) {
      console.log("sessionId index doesn't exist - no action needed")
    } else {
      console.log("Error dropping index:", error.message)
    }
  }
}

// Call this when your server starts
mongoose.connection.once("open", async () => {
  console.log("Connected to MongoDB")
  await fixPersonalityAssessmentIndexes()
})

// ================================
// START THE SERVER
// ================================
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  console.log(`Health check available at http://localhost:${PORT}/health`)
  console.log(`Using Ollama model: ${OLLAMA_MODEL}`)
  console.log(`Ollama host: ${process.env.OLLAMA_BASE_URL}`)
})
