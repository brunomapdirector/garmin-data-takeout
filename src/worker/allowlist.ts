// The only Garmin paths the relay forwards: the GET endpoints of the Personal API
// (Swagger v1.0.0, checked 2026-11-23). `{x}` is one path segment of letters, digits
// and dashes (ids and yyyy-MM-dd dates). Anything else gets a 404 from the relay.

const PATHS = [
  '/activity-service/activity/activityTypes/simple',
  '/activity-service/activity/{activityId}',
  '/activity-service/activity/{activityId}/workouts',
  '/activitylist-service/activities/search/activities',
  '/download-service/files/activity/{activityId}',
  '/wellnessactivity-service/activity/summary/range/{fromDate}/{untilDate}',
  '/biometric-service/heartRateZones/v2',
  '/fitnessage-service/fitnessage/v2/{calendarDate}',
  '/goal-service/goal/user/effective/weightgoal/{startDate}/{endDate}',
  '/hrv-service/hrv/{calendarDate}',
  '/hrv-service/hrv/daily/{fromDate}/{toDate}',
  '/metrics-service/metrics/maxmet/daily/{startDate}/{endDate}',
  '/nutrition-service/food/logs/{date}',
  '/sleep-service/sleep/dailySleep',
  '/sleep-service/sleep/dailySleepSummariesByDate',
  '/usersummary-service/stats/hydration/daily/{startDate}/{endDate}',
  '/usersummary-service/stats/steps/daily/{startDate}/{endDate}',
  '/usersummary-service/stats/stress/daily/{startDate}/{endDate}',
  '/usersummary-service/usersummary/daily',
  '/usersummary-service/v2/dailysummaries',
  '/weight-service/weight/all/{startDate}/{endDate}',
  '/weight-service/weight/range/{startDate}/{endDate}',
  '/wellness-service/wellness/bodyBattery/reports/daily',
  '/wellness-service/wellness/daily/spo2acclimation/{calendarDate}',
  '/wellness-service/wellness/dailyHeartRate',
  '/periodichealth-service/menstrualcycle/summary/{calendarDate}',
  '/periodichealth-service/menstrualcycle/dayview/{calendarDate}',
  '/userprofile-service/userprofile/settings',
];

const PATTERNS = PATHS.map(
  (p) => new RegExp('^' + p.replace(/\{[^}]+\}/g, '[A-Za-z0-9-]+') + '$'),
);

export function isAllowedPath(path: string): boolean {
  return PATTERNS.some((re) => re.test(path));
}
