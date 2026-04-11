import { useState } from "react"
import { Loader2, CheckCircle2, XCircle, ArrowLeft } from "lucide-react"
import { motion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { OnboardingState } from "../use-onboarding-state"

interface GatewayStepProps {
  state: OnboardingState
}

/**
 * Crewm8 gateway connection step. Replaces the old "Sign in to Rowboat" step
 * in onboarding with a direct base-URL + model + API-key form that writes
 * models.json directly. This is the core of the gateway client model — the
 * user points the app at any OpenAI-compatible endpoint (hermes, openclaw,
 * a cloud LLM provider, etc.) and the rest of the app "just works".
 */
export function GatewayStep({ state }: GatewayStepProps) {
  const { handleBack, handleNext } = state

  const [baseURL, setBaseURL] = useState("")
  const [model, setModel] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [testState, setTestState] = useState<{
    status: "idle" | "testing" | "success" | "error"
    error?: string
  }>({ status: "idle" })
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")

  const canTest = baseURL.trim().length > 0 && model.trim().length > 0

  const handleTest = async () => {
    if (!canTest) return
    setTestState({ status: "testing" })
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 90_000)

      const url = baseURL.trim().replace(/\/$/, "") + "/chat/completions"
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }
      if (apiKey.trim()) {
        headers["Authorization"] = `Bearer ${apiKey.trim()}`
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: model.trim(),
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 8,
          stream: false,
        }),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        const msg = text ? `HTTP ${response.status}: ${text.slice(0, 200)}` : `HTTP ${response.status}`
        setTestState({ status: "error", error: msg })
        return
      }

      await response.json()
      setTestState({ status: "success" })
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        setTestState({ status: "error", error: "Request timed out after 90 s. Gateway may still work — try Save Connection anyway." })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        setTestState({ status: "error", error: msg })
      }
    }
  }

  const handleSaveAndContinue = async () => {
    if (!canTest) return
    setSaveState("saving")
    try {
      const providerConfig = {
        provider: {
          flavor: "openai-compatible" as const,
          apiKey: apiKey.trim() || "unused",
          baseURL: baseURL.trim(),
        },
        model: model.trim(),
      }
      await window.ipc.invoke("models:saveConfig", providerConfig)
      window.dispatchEvent(new Event("models-config-changed"))
      setSaveState("saved")
      setTimeout(() => handleNext(), 400)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setSaveState("error")
      console.error("Failed to save gateway config:", msg)
      setTestState({ status: "error", error: `Save failed: ${msg}` })
    }
  }

  const resetOnChange = () => {
    if (testState.status !== "idle") setTestState({ status: "idle" })
    if (saveState !== "idle") setSaveState("idle")
  }

  return (
    <div className="flex flex-col flex-1">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <h2 className="text-3xl font-bold tracking-tight text-center mb-2">
          Connect your gateway
        </h2>
        <p className="text-base text-muted-foreground text-center mb-8">
          Point Crewm8 at your crewmate agent. Any OpenAI-compatible endpoint works.
          You can change this anytime in Settings.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="space-y-5"
      >
        <div className="space-y-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Base URL
          </label>
          <Input
            value={baseURL}
            onChange={(e) => { setBaseURL(e.target.value); resetOnChange() }}
            placeholder="http://100.127.242.92:8642/v1"
            className="font-mono"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            The OpenAI-compatible base URL of your gateway, ending in <code className="font-mono">/v1</code>.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Model
          </label>
          <Input
            value={model}
            onChange={(e) => { setModel(e.target.value); resetOnChange() }}
            placeholder="hermes-agent"
            className="font-mono"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            The model name your gateway expects (e.g. <code className="font-mono">hermes-agent</code>).
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            API Key <span className="normal-case font-normal">(optional)</span>
          </label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); resetOnChange() }}
            placeholder="Leave blank if your gateway doesn't require auth"
            className="font-mono"
          />
        </div>
      </motion.div>

      {testState.status !== "idle" && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            "mt-5 rounded-xl border px-4 py-3 flex items-start gap-3 text-sm",
            testState.status === "success"
              ? "border-green-200 bg-green-50/50 dark:border-green-800/50 dark:bg-green-900/10"
              : testState.status === "error"
                ? "border-destructive/30 bg-destructive/5"
                : "border-border bg-muted/30"
          )}
        >
          {testState.status === "testing" && (
            <Loader2 className="size-4 animate-spin text-muted-foreground mt-0.5 shrink-0" />
          )}
          {testState.status === "success" && (
            <CheckCircle2 className="size-4 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
          )}
          {testState.status === "error" && (
            <XCircle className="size-4 text-destructive mt-0.5 shrink-0" />
          )}
          <span className={cn(
            testState.status === "success" && "text-green-700 dark:text-green-300",
            testState.status === "error" && "text-destructive",
            testState.status === "testing" && "text-muted-foreground",
          )}>
            {testState.status === "testing" && "Testing connection — this can take up to 90 s for remote gateways..."}
            {testState.status === "success" && "Connected successfully."}
            {testState.status === "error" && (testState.error ?? "Connection failed.")}
          </span>
        </motion.div>
      )}

      <div className="flex items-center justify-between mt-8 pt-4 border-t">
        <Button variant="ghost" onClick={handleBack} className="gap-1">
          <ArrowLeft className="size-4" />
          Back
        </Button>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={!canTest || testState.status === "testing" || saveState === "saving"}
          >
            {testState.status === "testing" ? (
              <><Loader2 className="size-4 animate-spin mr-2" />Testing...</>
            ) : testState.status === "success" ? (
              <><CheckCircle2 className="size-4 mr-2 text-green-600 dark:text-green-400" />Test OK</>
            ) : (
              "Test Connection"
            )}
          </Button>

          <Button
            onClick={handleSaveAndContinue}
            disabled={!canTest || saveState === "saving"}
            className="min-w-[160px]"
          >
            {saveState === "saving" ? (
              <><Loader2 className="size-4 animate-spin mr-2" />Saving...</>
            ) : saveState === "saved" ? (
              <><CheckCircle2 className="size-4 mr-2" />Saved</>
            ) : (
              "Save and Continue"
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
