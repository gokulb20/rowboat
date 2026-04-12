import { useCallback, useEffect, useState } from "react"

/**
 * Shape of a calendar event surfaced to the UI by the `meeting:getUpcomingEvents`
 * IPC. This is a deliberately small subset of the Google Calendar event — just
 * what the record-meeting picker needs.
 */
export interface UpcomingMeeting {
  id: string
  summary: string
  startDateTime: string
  endDateTime: string
  attendees: string[]
  htmlLink?: string
  location?: string
}

/**
 * Polls the main process for calendar events that are starting soon (or are
 * currently in progress) so the meeting-record button can show a picker. The
 * hook is intentionally lightweight: a single fetch on mount + manual `refresh`.
 *
 * Callers typically also trigger `refresh()` after a recording finishes so the
 * next click sees fresh data without waiting for the calendar sync interval.
 */
export function useUpcomingMeetings() {
  const [meetings, setMeetings] = useState<UpcomingMeeting[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.ipc.invoke('meeting:getUpcomingEvents', null) as { meetings: UpcomingMeeting[] }
      setMeetings(result.meetings)
    } catch (err) {
      console.warn('[useUpcomingMeetings] fetch failed:', err)
      setMeetings([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { meetings, loading, refresh }
}
