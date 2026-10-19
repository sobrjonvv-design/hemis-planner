(function (global) {
  const {
    DAYS_OF_WEEK,
    loginToHemis,
    fetchScheduleWithToken,
    normalizeHemisSchedulePayload,
    getDemoHemisData,
    loadLocalState,
    saveLocalState,
    loadReminderSettings,
    saveReminderSettings,
    loadHemisAuthConfig,
    saveHemisAuthConfig,
    loadCloudConfig,
    saveCloudConfig,
    isCloudConfigured,
    pushStateToCloud,
    pullStateFromCloud,
    exportStateToJsonFile
  } = global.HemisPlanner;

  let appState = loadLocalState();
  let reminderSettings = loadReminderSettings();
  let hemisConfig = loadHemisAuthConfig();
  let cloudConfig = loadCloudConfig();
  let currentHemisMode = 'credentials';
  let activeDayFilter = 'all'; // 'all' | 1..6
  let autoSyncTimeout = null;
  let editingSubtasks = [];
  let deferredPwaPrompt = null;
  let lastLiveLessonId = null;

  function getTodayAndTomorrowDays() {
    const now = new Date();
    const jsDay = now.getDay();
    const todayId = jsDay === 0 ? 7 : jsDay;
    const tomorrowId = todayId === 7 ? 1 : todayId + 1;
    return { todayId, tomorrowId, now };
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(message) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3200);
  }

  function persistState(triggerCloud = true) {
    appState = saveLocalState(appState);
    renderAll();

    if (triggerCloud && isCloudConfigured(cloudConfig)) {
      clearTimeout(autoSyncTimeout);
      autoSyncTimeout = setTimeout(async () => {
        try {
          await pushStateToCloud(appState, cloudConfig);
          updateCloudStatusIndicator(true);
        } catch (err) {
          console.warn('Фоновая синхронизация:', err.message);
        }
      }, 1000);
    }
  }

  function updateCloudStatusIndicator(online = isCloudConfigured(cloudConfig)) {
    const dot = document.getElementById('cloudStatusDot');
    const text = document.getElementById('cloudStatusText');
    if (!dot || !text) return;

    if (online && cloudConfig.quickId) {
      dot.classList.add('online');
      text.textContent = `Облако (${cloudConfig.quickId})`;
    } else {
      dot.classList.remove('online');
      text.textContent = 'Облако';
    }
  }

  function updateReminderStatusIndicator() {
    const dot = document.getElementById('reminderStatusDot');
    if (!dot) return;
    dot.classList.toggle('online', Boolean(reminderSettings.enabled));
  }

  function getSubjectAttendance(subjectName) {
    const clean = (subjectName || '').trim();
    if (!appState.attendance) appState.attendance = {};

    let recordKey = Object.keys(appState.attendance).find(
      (k) => k.toLowerCase().trim() === clean.toLowerCase()
    );

    if (!recordKey) {
      appState.attendance[clean] = {
        subject: clean,
        missedHours: 0,
        unexcusedHours: 0,
        excusedHours: 0,
        totalHours: 60
      };
      recordKey = clean;
    }

    const rec = appState.attendance[recordKey];
    const totalHours = Number(rec.totalHours) > 0 ? Number(rec.totalHours) : 60;
    const missedHours = Math.max(0, Number(rec.missedHours) || 0);
    const limitHours = Math.max(2, Math.floor(totalHours * 0.25));
    const ratio = missedHours / limitHours;

    let status = 'safe';
    if (ratio >= 0.85) status = 'danger';
    else if (ratio >= 0.6) status = 'warn';

    return {
      key: recordKey,
      missedHours,
      totalHours,
      limitHours,
      percent: Math.min(100, Math.round(ratio * 100)),
      status
    };
  }

  function adjustSubjectMissedHours(subjectName, deltaHours) {
    const info = getSubjectAttendance(subjectName);
    const rec = appState.attendance[info.key];
    rec.missedHours = Math.max(0, (Number(rec.missedHours) || 0) + deltaHours);
    persistState();
    showToast(`НБ «${subjectName}»: ${rec.missedHours} из ${info.limitHours} ч.`);
  }

  function setSubjectTotalHours(subjectName, totalHours) {
    const info = getSubjectAttendance(subjectName);
    const rec = appState.attendance[info.key];
    rec.totalHours = Math.max(12, Number(totalHours) || 60);
    persistState();
    showToast(`Нагрузка предмета: ${rec.totalHours} ч.`);
  }

  function parseTimeToSeconds(timeStr) {
    const parts = String(timeStr || '08:30').split(':');
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    return h * 3600 + m * 60;
  }

  function formatDuration(sec) {
    const total = Math.max(0, Math.floor(sec));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  /**
   * Компактный живой статус и таймер внутри верхнего статус-бара
   */
  function renderLiveClassTimer() {
    const banner = document.getElementById('liveTimerBanner');
    const subtextEl = document.getElementById('briefingSubtext');
    if (!banner) return;

    const { todayId, tomorrowId, now } = getTodayAndTomorrowDays();
    const activeDayIds = new Set(appState.lessons.map((l) => Number(l.dayOfWeek)));
    const pendingTasks = appState.tasks.filter((t) => !t.completed);

    if (appState.lessons.length === 0) {
      banner.innerHTML = `<span class="live-headline">Добро пожаловать в HEMIS Planner</span>`;
      if (subtextEl) {
        subtextEl.textContent =
          'Нажмите «HEMIS» вверху, чтобы загрузить ваше расписание и записывать задания к парам.';
      }
      return;
    }

    const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const todayLessons = appState.lessons
      .filter((l) => Number(l.dayOfWeek) === todayId)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    let currentLesson = null;
    let nextLesson = null;

    for (let i = 0; i < todayLessons.length; i++) {
      const l = todayLessons[i];
      const startSec = parseTimeToSeconds(l.startTime);
      const endSec = parseTimeToSeconds(l.endTime);

      if (nowSec >= startSec && nowSec < endSec) {
        currentLesson = { ...l, startSec, endSec };
        nextLesson = todayLessons[i + 1] || null;
        break;
      }
      if (nowSec < startSec && !nextLesson) {
        nextLesson = { ...l, startSec, endSec };
      }
    }

    const currentId = currentLesson ? currentLesson.id : null;
    if (currentId !== lastLiveLessonId) {
      lastLiveLessonId = currentId;
      document.querySelectorAll('.lesson-item').forEach((el) => {
        el.classList.toggle('is-live-now', el.getAttribute('data-lesson-id') === currentId);
      });
    }

    // 1. Сейчас идёт пара
    if (currentLesson) {
      const remainSec = currentLesson.endSec - nowSec;
      const totalDur = Math.max(1, currentLesson.endSec - currentLesson.startSec);
      const elapsedPercent = Math.min(
        100,
        Math.max(0, Math.round(((nowSec - currentLesson.startSec) / totalDur) * 100))
      );

      banner.innerHTML = `
        <div class="live-timer-inline">
          <div class="live-timer-top">
            <span class="live-status-pill">
              <span class="pulse-dot"></span>
              СЕЙЧАС ИДЁТ • ${escapeHtml(currentLesson.pairName)}
            </span>
            <span class="live-countdown-box">Осталось ${formatDuration(remainSec)}</span>
          </div>
          <div class="live-subject-title">
            ${escapeHtml(currentLesson.subject)} <span style="font-weight:600; color:var(--accent-primary);">• ауд. ${escapeHtml(
        currentLesson.room
      )}</span>
          </div>
          <div class="live-progress-track">
            <div class="live-progress-fill" style="width:${elapsedPercent}%"></div>
          </div>
        </div>
      `;
      if (subtextEl) {
        subtextEl.innerHTML = nextLesson
          ? `Следующая пара: <strong>${escapeHtml(nextLesson.subject)}</strong> в ${escapeHtml(
              nextLesson.startTime
            )} (ауд. ${escapeHtml(nextLesson.room)})`
          : 'Это заключительная пара на сегодня';
      }
      return;
    }

    // 2. Перемена или до начала сегодняшней пары
    if (nextLesson) {
      const waitSec = nextLesson.startSec - nowSec;
      const isBreak = todayLessons[0] && nowSec >= parseTimeToSeconds(todayLessons[0].endTime);

      banner.innerHTML = `
        <div class="live-timer-inline">
          <div class="live-timer-top">
            <span class="live-status-pill ${isBreak ? 'break-mode' : 'upcoming'}">
              <span class="pulse-dot"></span>
              ${isBreak ? '☕ ПЕРЕМЕНА' : '⏳ СЕГОДНЯ'} • ${escapeHtml(nextLesson.pairName)} в ${escapeHtml(
        nextLesson.startTime
      )}
            </span>
            <span class="live-countdown-box">Через ${formatDuration(waitSec)}</span>
          </div>
          <div class="live-subject-title">
            ${escapeHtml(nextLesson.subject)} <span style="font-weight:600; color:var(--accent-primary);">• ауд. ${escapeHtml(
        nextLesson.room
      )}</span>
          </div>
        </div>
      `;
      if (subtextEl) {
        subtextEl.textContent = `${nextLesson.trainingType} • ${nextLesson.teacher}`;
      }
      return;
    }

    // 3. Пары на сегодня завершены
    const tomorrowLessons = appState.lessons
      .filter((l) => Number(l.dayOfWeek) === tomorrowId)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    const tomorrowObj = DAYS_OF_WEEK.find((d) => d.id === tomorrowId);

    banner.innerHTML = `
      <span class="live-headline">
        Учебная неделя: ${activeDayIds.size} ${pluralize(
      activeDayIds.size,
      'день',
      'дня',
      'дней'
    )} (${appState.lessons.length} ${pluralize(appState.lessons.length, 'пара', 'пары', 'пар')})
      </span>
    `;

    if (subtextEl) {
      if (tomorrowLessons.length > 0) {
        const firstTom = tomorrowLessons[0];
        subtextEl.innerHTML = `Завтра (${
          tomorrowObj ? tomorrowObj.short : 'Завтра'
        }) 1-я пара в <strong>${escapeHtml(firstTom.startTime)}</strong>: ${escapeHtml(
          firstTom.subject
        )} (ауд. ${escapeHtml(firstTom.room)})`;
      } else {
        subtextEl.textContent = `Активных заданий: ${pendingTasks.length}`;
      }
    }
  }

  function renderAll() {
    renderHeaderAndMetrics();
    renderLiveClassTimer();
    renderSmartAlerts();
    renderScheduleByDays();
    renderAllTasksTab();
    renderSubjectsAnalyticsTab();
    populateSubjectDropdowns();
    updateCloudStatusIndicator();
    updateReminderStatusIndicator();
  }

  function renderHeaderAndMetrics() {
    const { todayId, tomorrowId, now } = getTodayAndTomorrowDays();

    const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });
    const formattedDate = dateFormatter.format(now);
    document.getElementById('currentDateDisplay').textContent =
      formattedDate.charAt(0).toUpperCase() + formattedDate.slice(1);

    const badgeEl = document.getElementById('studentBadge');
    if (appState.studentProfile) {
      const { fullName, groupName } = appState.studentProfile;
      const parts = [fullName, groupName].filter(Boolean);
      badgeEl.textContent = parts.join(' • ');
    } else {
      badgeEl.textContent = 'Расписание и задания';
    }

    const pendingTasks = appState.tasks.filter((t) => !t.completed);
    const completedTasks = appState.tasks.filter((t) => t.completed);

    const totalMissedHours = Object.values(appState.attendance || {}).reduce(
      (acc, r) => acc + (Number(r.missedHours) || 0),
      0
    );

    // Компактная полоса дней недели (Все | Пн | Вт | Ср | Чт | Пт | Сб)
    const stripEl = document.getElementById('weekDaysStrip');
    const allPillHtml = `
      <button type="button" class="day-pill ${activeDayFilter === 'all' ? 'active-filter' : ''}"
              data-filter-day="all">
        <span>Все дни</span>
      </button>
    `;

    const daysPillsHtml = DAYS_OF_WEEK.map((day) => {
      const dayLessons = appState.lessons.filter((l) => Number(l.dayOfWeek) === day.id);
      const dayPendingTasks = pendingTasks.filter((t) => Number(t.dayOfWeek) === day.id);
      const hasUrgent = dayPendingTasks.some((t) => t.priority === 'urgent');
      const isToday = day.id === todayId;
      const isSelected = String(activeDayFilter) === String(day.id);

      return `
        <button type="button"
                class="day-pill ${dayLessons.length > 0 ? 'has-classes' : ''} ${
        isToday ? 'is-today' : ''
      } ${isSelected ? 'active-filter' : ''}"
                data-filter-day="${day.id}"
                title="${day.name}: ${dayLessons.length} пар, ${dayPendingTasks.length} заданий">
          <span>${day.short}</span>
          ${
            dayPendingTasks.length > 0
              ? `<span class="day-pill-dot ${hasUrgent ? 'urgent' : ''}"></span>`
              : ''
          }
        </button>
      `;
    }).join('');

    stripEl.innerHTML = allPillHtml + daysPillsHtml;

    // 3 компактные пилюли метрик
    const todayLessons = appState.lessons.filter((l) => Number(l.dayOfWeek) === todayId);
    const tomorrowLessons = appState.lessons.filter((l) => Number(l.dayOfWeek) === tomorrowId);
    const todayPending = pendingTasks.filter((t) => Number(t.dayOfWeek) === todayId);
    const tomorrowPending = pendingTasks.filter((t) => Number(t.dayOfWeek) === tomorrowId);

    document.getElementById('statTodayClasses').textContent =
      todayLessons.length > 0
        ? `${todayLessons.length} ${pluralize(todayLessons.length, 'пара', 'пары', 'пар')}`
        : 'Выходной';
    document.getElementById('statTodayTasks').textContent =
      todayPending.length > 0 ? `${todayPending.length} к сдаче` : 'Без долгов';

    document.getElementById('statTomorrowClasses').textContent =
      tomorrowLessons.length > 0
        ? `${tomorrowLessons.length} ${pluralize(tomorrowLessons.length, 'пара', 'пары', 'пар')}`
        : 'Выходной';
    document.getElementById('statTomorrowTasks').textContent =
      tomorrowPending.length > 0 ? `${tomorrowPending.length} подгот.` : 'Всё готово';

    document.getElementById('statTotalPending').textContent = `${totalMissedHours} ч.`;
    document.getElementById('statCompletedTotal').textContent = `Готово: ${completedTasks.length}`;
    document.getElementById('tabTasksCounter').textContent = String(pendingTasks.length);
  }

  function renderSmartAlerts() {
    const container = document.getElementById('smartAlertsSection');
    if (appState.lessons.length === 0 && appState.tasks.length === 0) {
      container.innerHTML = '';
      return;
    }

    const { todayId, tomorrowId } = getTodayAndTomorrowDays();
    const todayObj = DAYS_OF_WEEK.find((d) => d.id === todayId);
    const tomorrowObj = DAYS_OF_WEEK.find((d) => d.id === tomorrowId);

    const todayTasks = appState.tasks.filter(
      (t) => !t.completed && Number(t.dayOfWeek) === todayId
    );
    const tomorrowTasks = appState.tasks.filter(
      (t) => !t.completed && Number(t.dayOfWeek) === tomorrowId
    );

    const cards = [];

    if (todayTasks.length > 0) {
      cards.push(`
        <div class="smart-alert-card">
          <div class="smart-alert-header">
            <span>📌 На сегодня (${todayObj ? todayObj.short : 'Сегодня'})</span>
            <span class="tag tag-urgent">${todayTasks.length}</span>
          </div>
          <ul class="smart-alert-list">
            ${todayTasks
              .map(
                (t) => `
              <li>
                <span><strong>${escapeHtml(t.subject)}:</strong> ${escapeHtml(t.title)}</span>
                <button class="btn btn-xs btn-ghost" data-quick-complete="${escapeHtml(
                  t.id
                )}">✓</button>
              </li>
            `
              )
              .join('')}
          </ul>
        </div>
      `);
    }

    if (tomorrowTasks.length > 0) {
      cards.push(`
        <div class="smart-alert-card alert-tomorrow">
          <div class="smart-alert-header">
            <span>⏰ На завтра (${tomorrowObj ? tomorrowObj.short : 'Завтра'})</span>
            <span class="tag tag-high">${tomorrowTasks.length}</span>
          </div>
          <ul class="smart-alert-list">
            ${tomorrowTasks
              .map(
                (t) => `
              <li>
                <span><strong>${escapeHtml(t.subject)}:</strong> ${escapeHtml(t.title)}</span>
                <button class="btn btn-xs btn-ghost" data-quick-complete="${escapeHtml(
                  t.id
                )}">✓</button>
              </li>
            `
              )
              .join('')}
          </ul>
        </div>
      `);
    }

    container.innerHTML = cards.join('');
  }

  function renderScheduleByDays() {
    const emptyBanner = document.getElementById('emptyScheduleBanner');
    const gridEl = document.getElementById('daysScheduleGrid');

    if (appState.lessons.length === 0 && appState.tasks.length === 0) {
      emptyBanner.classList.remove('hidden');
      gridEl.innerHTML = '';
      return;
    }
    emptyBanner.classList.add('hidden');

    const hideCompletedInline = document.getElementById('chkHideCompletedInline').checked;
    const { todayId, tomorrowId } = getTodayAndTomorrowDays();

    const daysToRender = DAYS_OF_WEEK.filter((day) => {
      if (activeDayFilter !== 'all') {
        return Number(activeDayFilter) === day.id;
      }
      const hasClasses = appState.lessons.some((l) => Number(l.dayOfWeek) === day.id);
      const hasTasks = appState.tasks.some((t) => Number(t.dayOfWeek) === day.id);
      return hasClasses || hasTasks;
    });

    if (daysToRender.length === 0) {
      const selectedDayObj = DAYS_OF_WEEK.find((d) => d.id === Number(activeDayFilter));
      gridEl.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <h2>${selectedDayObj ? selectedDayObj.name : 'День'} — свободный от пар день</h2>
          <p>В этот день нет занятий по расписанию HEMIS.</p>
          <div class="empty-actions">
            <button class="btn btn-secondary btn-sm" data-filter-day="all">Показать все учебные дни</button>
          </div>
        </div>
      `;
      return;
    }

    gridEl.innerHTML = daysToRender
      .map((day, cardIdx) => {
        const dayLessons = appState.lessons
          .filter((l) => Number(l.dayOfWeek) === day.id)
          .sort((a, b) => a.startTime.localeCompare(b.startTime));

        const dayAllTasks = appState.tasks.filter((t) => Number(t.dayOfWeek) === day.id);
        const dayPendingCount = dayAllTasks.filter((t) => !t.completed).length;

        const isToday = day.id === todayId;
        const isTomorrow = day.id === tomorrowId;
        const renderedSubjectsInDay = new Set();

        const lessonsHtml = dayLessons
          .map((lesson) => {
            const subjKey = lesson.subject.toLowerCase().trim();
            renderedSubjectsInDay.add(subjKey);

            const matchingTasks = dayAllTasks.filter((t) => {
              if (hideCompletedInline && t.completed) return false;
              return t.subject.toLowerCase().trim() === subjKey;
            });

            const nb = getSubjectAttendance(lesson.subject);
            const nbBadgeClass =
              nb.status === 'danger'
                ? 'nb-danger'
                : nb.status === 'warn'
                ? 'nb-warn'
                : 'nb-safe';

            const isLive = lesson.id === lastLiveLessonId;

            return `
              <article class="lesson-item ${isLive ? 'is-live-now' : ''}" data-lesson-id="${escapeHtml(
              lesson.id
            )}">
                <div class="lesson-main">
                  <div class="lesson-top-row">
                    <span class="lesson-time-badge">
                      ${escapeHtml(lesson.startTime)}–${escapeHtml(lesson.endTime)} • ${escapeHtml(
              lesson.pairName
            )}
                    </span>
                    <div class="lesson-badges-right">
                      <span class="nb-badge ${nbBadgeClass}"
                            data-open-nb-tab="true"
                            title="Пропуски НБ: ${nb.missedHours} из ${
              nb.limitHours
            } ч. Нажмите для управления">
                        НБ: ${nb.missedHours}/${nb.limitHours} ч.
                      </span>
                      <span class="lesson-type-badge">${escapeHtml(lesson.trainingType)}</span>
                      <button class="btn-micro" title="Удалить пару" data-delete-lesson="${escapeHtml(
                        lesson.id
                      )}">✕</button>
                    </div>
                  </div>

                  <h3 class="lesson-subject-name">${escapeHtml(lesson.subject)}</h3>

                  <div class="lesson-details-row">
                    <div class="lesson-meta-spans">
                      <span>📍 ауд. <strong>${escapeHtml(lesson.room)}</strong></span>
                      <span>👤 ${escapeHtml(lesson.teacher)}</span>
                    </div>
                  </div>
                </div>

                <!-- Блок заданий ПРЯМО ПОД ПРЕДМЕТОМ в этот день недели -->
                <div class="lesson-tasks-container">
                  <div class="lesson-tasks-header">
                    <span class="lesson-tasks-title">
                      ${
                        matchingTasks.length > 0
                          ? `Задания (${matchingTasks.filter((t) => !t.completed).length})`
                          : 'Нет заданий к паре'
                      }
                    </span>
                    <button class="btn btn-xs btn-ghost"
                            data-add-task-subject="${escapeHtml(lesson.subject)}"
                            data-add-task-day="${day.id}">
                      + Задание
                    </button>
                  </div>

                  ${
                    matchingTasks.length > 0
                      ? `<div class="inline-tasks-list">
                          ${matchingTasks.map((task) => renderInlineTaskItem(task)).join('')}
                         </div>`
                      : ''
                  }
                </div>
              </article>
            `;
          })
          .join('');

        const extraTasks = dayAllTasks.filter((t) => {
          if (hideCompletedInline && t.completed) return false;
          return !renderedSubjectsInDay.has(t.subject.toLowerCase().trim());
        });

        const extraTasksHtml =
          extraTasks.length > 0
            ? `
              <article class="lesson-item">
                <div class="lesson-tasks-container" style="border-top:none;">
                  <div class="lesson-tasks-header">
                    <span class="lesson-tasks-title">Дополнительные задания</span>
                  </div>
                  <div class="inline-tasks-list">
                    ${extraTasks.map((task) => renderInlineTaskItem(task, true)).join('')}
                  </div>
                </div>
              </article>
            `
            : '';

        return `
          <div class="day-card ${isToday ? 'today-highlight' : ''}"
               id="dayCard_${day.id}"
               style="animation-delay: ${cardIdx * 55}ms">
            <div class="day-card-header">
              <div class="day-card-title">
                <span>${day.name}</span>
                ${isToday ? '<span class="today-tag">Сегодня</span>' : ''}
                ${isTomorrow ? '<span class="tomorrow-tag">Завтра</span>' : ''}
              </div>
              <div class="day-card-meta">
                ${dayLessons.length} ${pluralize(dayLessons.length, 'пара', 'пары', 'пар')}
                ${dayPendingCount > 0 ? ` • ${dayPendingCount} зад.` : ''}
              </div>
            </div>

            <div class="day-lessons-list">
              ${
                dayLessons.length > 0
                  ? lessonsHtml
                  : `<div class="inline-task-sub" style="text-align:center; padding:0.65rem;">
                       Свободный от пар день
                     </div>`
              }
              ${extraTasksHtml}
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderInlineTaskItem(task, showSubjectName = false) {
    const priorityClass =
      task.priority === 'urgent'
        ? 'priority-urgent'
        : task.priority === 'high'
        ? 'priority-high'
        : '';

    const priorityBadge =
      task.priority === 'urgent'
        ? '<span class="tag tag-urgent">Срочно</span>'
        : task.priority === 'high'
        ? '<span class="tag tag-high">Важно</span>'
        : '';

    const subDetails = [
      showSubjectName ? task.subject : null,
      task.type || null,
      task.deadline ? `до ${task.deadline}` : null,
      task.notes ? task.notes : null
    ].filter(Boolean);

    let linkHtml = '';
    if (task.link) {
      let hostLabel = 'Ссылка';
      try {
        hostLabel = new URL(task.link).hostname.replace(/^www\./, '');
      } catch (_) {}
      linkHtml = `
        <a href="${escapeHtml(task.link)}" target="_blank" rel="noopener noreferrer" class="task-link-pill">
          🔗 ${escapeHtml(hostLabel)} ↗
        </a>
      `;
    }

    let subtasksHtml = '';
    if (Array.isArray(task.subtasks) && task.subtasks.length > 0) {
      const doneCount = task.subtasks.filter((s) => s.done).length;
      const totalCount = task.subtasks.length;
      const pct = Math.round((doneCount / totalCount) * 100);

      subtasksHtml = `
        <div class="inline-subtasks-box">
          <div class="subtasks-progress-header">
            <span>Шаги: ${doneCount}/${totalCount}</span>
            <span>${pct}%</span>
          </div>
          <div class="subtask-mini-bar">
            <div class="subtask-mini-fill" style="width:${pct}%"></div>
          </div>
          ${task.subtasks
            .map(
              (sub) => `
            <label class="inline-subtask-row ${sub.done ? 'done' : ''}">
              <input type="checkbox"
                     data-toggle-subtask="${escapeHtml(sub.id)}"
                     data-parent-task="${escapeHtml(task.id)}"
                     ${sub.done ? 'checked' : ''} />
              <span>${escapeHtml(sub.text)}</span>
            </label>
          `
            )
            .join('')}
        </div>
      `;
    }

    return `
      <div class="inline-task-item ${priorityClass} ${task.completed ? 'completed' : ''}">
        <div class="inline-task-left">
          <input type="checkbox"
                 class="task-checkbox"
                 data-toggle-task="${escapeHtml(task.id)}"
                 ${task.completed ? 'checked' : ''}
                 aria-label="Отметить выполнение" />
          <div class="inline-task-content">
            <div class="inline-task-text">
              ${escapeHtml(task.title)} ${priorityBadge}
            </div>
            ${
              subDetails.length > 0
                ? `<div class="inline-task-sub">${escapeHtml(subDetails.join(' • '))}</div>`
                : ''
            }
            ${linkHtml}
            ${subtasksHtml}
          </div>
        </div>
        <div class="inline-task-actions">
          <button class="btn-micro" title="Изменить" data-edit-task="${escapeHtml(
            task.id
          )}">✎</button>
          <button class="btn-micro" title="Удалить" data-delete-task="${escapeHtml(
            task.id
          )}">✕</button>
        </div>
      </div>
    `;
  }

  function renderAllTasksTab() {
    const container = document.getElementById('allTasksList');
    const query = (document.getElementById('taskSearchInput')?.value || '')
      .toLowerCase()
      .trim();
    const subjectFilter = document.getElementById('taskSubjectFilter')?.value || 'all';
    const statusFilter = document.getElementById('taskStatusFilter')?.value || 'all';

    const filtered = appState.tasks.filter((task) => {
      if (statusFilter === 'pending' && task.completed) return false;
      if (statusFilter === 'completed' && !task.completed) return false;
      if (subjectFilter !== 'all' && task.subject !== subjectFilter) return false;
      if (query) {
        const subText = (task.subtasks || []).map((s) => s.text).join(' ');
        const hay = `${task.title} ${task.subject} ${task.notes || ''} ${
          task.type || ''
        } ${subText}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <h2>Список заданий пуст</h2>
          <p>Добавьте задание прямо под нужным предметом в расписании или нажмите «+ Задание».</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered
      .map((task) => {
        const dayObj = DAYS_OF_WEEK.find((d) => d.id === Number(task.dayOfWeek));
        const subtasksCount = Array.isArray(task.subtasks) ? task.subtasks.length : 0;
        const subtasksDone = subtasksCount
          ? task.subtasks.filter((s) => s.done).length
          : 0;

        return `
          <div class="full-task-card ${task.completed ? 'completed' : ''}">
            <div class="inline-task-left" style="width:100%;">
              <input type="checkbox"
                     class="task-checkbox"
                     data-toggle-task="${escapeHtml(task.id)}"
                     ${task.completed ? 'checked' : ''} />
              <div style="flex:1;">
                <div class="inline-task-text" style="font-size:0.92rem;">
                  ${escapeHtml(task.title)}
                </div>
                <div class="full-task-meta">
                  <span class="tag tag-subject">${escapeHtml(task.subject)}</span>
                  <span class="tag">${dayObj ? dayObj.name : 'Любой день'}</span>
                  ${task.type ? `<span class="tag">${escapeHtml(task.type)}</span>` : ''}
                  ${
                    subtasksCount > 0
                      ? `<span class="tag">☑️ ${subtasksDone}/${subtasksCount}</span>`
                      : ''
                  }
                  ${
                    task.deadline ? `<span class="tag">до ${escapeHtml(task.deadline)}</span>` : ''
                  }
                  ${
                    task.priority === 'urgent'
                      ? '<span class="tag tag-urgent">Срочно</span>'
                      : ''
                  }
                  ${
                    task.priority === 'high' ? '<span class="tag tag-high">Важно</span>' : ''
                  }
                </div>
                ${
                  task.notes
                    ? `<div class="inline-task-sub" style="margin-top:0.3rem;">${escapeHtml(
                        task.notes
                      )}</div>`
                    : ''
                }
                ${
                  task.link
                    ? `<a href="${escapeHtml(
                        task.link
                      )}" target="_blank" rel="noopener noreferrer" class="task-link-pill">🔗 Открыть ссылку ↗</a>`
                    : ''
                }
              </div>
            </div>
            <div class="inline-task-actions" style="opacity:1;">
              <button class="btn btn-xs btn-ghost" data-edit-task="${escapeHtml(
                task.id
              )}">✎</button>
              <button class="btn btn-xs btn-ghost" data-delete-task="${escapeHtml(
                task.id
              )}">✕</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderSubjectsAnalyticsTab() {
    const grid = document.getElementById('subjectsAnalyticsGrid');
    const summaryBanner = document.getElementById('attendanceSummaryBanner');
    const nbWarningCounter = document.getElementById('tabNbWarningCounter');
    const subjectMap = new Map();

    for (const lesson of appState.lessons) {
      const key = lesson.subject.trim();
      if (!subjectMap.has(key)) {
        subjectMap.set(key, {
          name: key,
          days: new Set(),
          types: new Set(),
          teachers: new Set(),
          lessonsCount: 0
        });
      }
      const entry = subjectMap.get(key);
      entry.days.add(Number(lesson.dayOfWeek));
      entry.types.add(lesson.trainingType);
      if (lesson.teacher) entry.teachers.add(lesson.teacher);
      entry.lessonsCount += 1;
    }

    for (const task of appState.tasks) {
      const key = task.subject.trim();
      if (!subjectMap.has(key)) {
        subjectMap.set(key, {
          name: key,
          days: new Set([Number(task.dayOfWeek)]),
          types: new Set(),
          teachers: new Set(),
          lessonsCount: 0
        });
      }
    }

    const subjects = Array.from(subjectMap.values());
    if (subjects.length === 0) {
      summaryBanner.innerHTML = '';
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <h2>Нет данных о предметах</h2>
          <p>Подключите расписание HEMIS, чтобы контролировать часы пропусков («НБ»).</p>
        </div>
      `;
      return;
    }

    let warningSubjectsCount = 0;
    let totalMissedAll = 0;

    for (const s of subjects) {
      const nb = getSubjectAttendance(s.name);
      totalMissedAll += nb.missedHours;
      if (nb.status === 'warn' || nb.status === 'danger') {
        warningSubjectsCount += 1;
      }
    }

    if (nbWarningCounter) {
      nbWarningCounter.classList.toggle('hidden', warningSubjectsCount === 0);
      nbWarningCounter.textContent = String(warningSubjectsCount);
    }

    summaryBanner.innerHTML = `
      <div>
        <h3 style="font-size:0.95rem; font-weight:700;">Контроль пропусков («НБ» / Davomat)</h3>
        <p class="inline-task-sub">
          Допустимый лимит — 25% от общей нагрузки предмета. Вы можете менять часы кнопками <code>−2 ч</code> / <code>+2 ч</code>.
        </p>
      </div>
      <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
        <span class="tag">Всего пропусков: <strong>${totalMissedAll} ч.</strong></span>
        ${
          warningSubjectsCount > 0
            ? `<span class="tag tag-urgent">Риск по ${warningSubjectsCount} предм.</span>`
            : `<span class="tag" style="color:var(--emerald);">Все предметы в норме</span>`
        }
      </div>
    `;

    grid.innerHTML = subjects
      .map((subj, idx) => {
        const subjTasks = appState.tasks.filter(
          (t) => t.subject.toLowerCase().trim() === subj.name.toLowerCase()
        );
        const pendingCount = subjTasks.filter((t) => !t.completed).length;

        const dayNames = Array.from(subj.days)
          .sort((a, b) => a - b)
          .map((dId) => DAYS_OF_WEEK.find((d) => d.id === dId)?.short || '—');

        const firstDay = Array.from(subj.days)[0] || 1;
        const nb = getSubjectAttendance(subj.name);
        const nbBadgeClass =
          nb.status === 'danger' ? 'nb-danger' : nb.status === 'warn' ? 'nb-warn' : 'nb-safe';
        const remainHours = Math.max(0, nb.limitHours - nb.missedHours);

        return `
          <div class="subject-card" style="animation-delay: ${idx * 45}ms">
            <div>
              <h3 class="subject-card-title">${escapeHtml(subj.name)}</h3>
              <div class="inline-task-sub">
                ${Array.from(subj.teachers).join(', ') || 'Преподаватель'}
              </div>
            </div>

            <div style="background:var(--bg-surface-elevated); padding:0.7rem; border-radius:8px; border:1px solid var(--border-color);">
              <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem;">
                <span class="nb-badge ${nbBadgeClass}">
                  НБ: ${nb.missedHours} / ${nb.limitHours} ч. (${nb.percent}%)
                </span>
                <span class="inline-task-sub">Запас: <strong>${remainHours} ч.</strong></span>
              </div>

              <div class="nb-progress-bar">
                <div class="nb-progress-fill ${nb.status}" style="width:${nb.percent}%"></div>
              </div>

              <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.55rem; gap:0.4rem;">
                <select class="input-select" style="padding:0.15rem 0.45rem; font-size:0.72rem; width:auto;"
                        data-subject-hours="${escapeHtml(subj.name)}">
                  ${[30, 45, 60, 75, 90, 120, 150]
                    .map(
                      (h) =>
                        `<option value="${h}" ${
                          nb.totalHours === h ? 'selected' : ''
                        }>Нагрузка ${h} ч. (лимит ${Math.floor(h * 0.25)} ч.)</option>`
                    )
                    .join('')}
                </select>

                <div class="nb-controls">
                  <button type="button" class="btn-nb-step" data-nb-delta="-2" data-nb-subject="${escapeHtml(
                    subj.name
                  )}">−2 ч</button>
                  <button type="button" class="btn-nb-step" data-nb-delta="2" data-nb-subject="${escapeHtml(
                    subj.name
                  )}">+2 ч</button>
                </div>
              </div>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:auto;">
              <div class="subject-days-badges">
                <span class="tag tag-subject">${escapeHtml(dayNames.join(', '))}</span>
                <span class="tag">Заданий: ${pendingCount}</span>
              </div>
              <button class="btn btn-xs btn-ghost"
                      data-add-task-subject="${escapeHtml(subj.name)}"
                      data-add-task-day="${firstDay}">
                + Задание
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function populateSubjectDropdowns() {
    const uniqueSubjects = Array.from(
      new Set([
        ...appState.lessons.map((l) => l.subject.trim()),
        ...appState.tasks.map((t) => t.subject.trim())
      ])
    ).filter(Boolean);

    const taskSelect = document.getElementById('taskSubjectSelect');
    const filterSelect = document.getElementById('taskSubjectFilter');

    if (taskSelect) {
      const prevVal = taskSelect.value;
      if (uniqueSubjects.length === 0) {
        taskSelect.innerHTML = `<option value="Общее задание">Общее задание</option>`;
      } else {
        taskSelect.innerHTML = uniqueSubjects
          .map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
          .join('');
      }
      if (prevVal && uniqueSubjects.includes(prevVal)) {
        taskSelect.value = prevVal;
      }
    }

    if (filterSelect) {
      const prevFilter = filterSelect.value;
      filterSelect.innerHTML =
        `<option value="all">Все предметы (${uniqueSubjects.length})</option>` +
        uniqueSubjects
          .map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
          .join('');
      if (prevFilter && (prevFilter === 'all' || uniqueSubjects.includes(prevFilter))) {
        filterSelect.value = prevFilter;
      }
    }
  }

  function renderSubtasksEditorInModal() {
    const listEl = document.getElementById('subtasksEditorList');
    if (!listEl) return;
    if (editingSubtasks.length === 0) {
      listEl.innerHTML = '';
      return;
    }
    listEl.innerHTML = editingSubtasks
      .map(
        (sub, idx) => `
        <li class="subtasks-editor-item">
          <span>${idx + 1}. ${escapeHtml(sub.text)}</span>
          <button type="button" class="btn-micro" data-remove-editor-subtask="${escapeHtml(
            sub.id
          )}">✕</button>
        </li>
      `
      )
      .join('');
  }

  function openTaskModal({ subject = '', dayOfWeek = 1, editTask = null } = {}) {
    const modal = document.getElementById('modalTask');
    const titleEl = document.getElementById('modalTaskTitle');
    const editIdInput = document.getElementById('taskEditId');
    const subjectSelect = document.getElementById('taskSubjectSelect');
    const customSubjectInput = document.getElementById('taskCustomSubjectInput');
    const daySelect = document.getElementById('taskDayOfWeekSelect');
    const prioritySelect = document.getElementById('taskPrioritySelect');
    const taskTitleInput = document.getElementById('taskTitleInput');
    const taskTypeSelect = document.getElementById('taskTypeSelect');
    const taskDeadlineInput = document.getElementById('taskDeadlineInput');
    const taskLinkInput = document.getElementById('taskLinkInput');
    const taskNotesInput = document.getElementById('taskNotesInput');
    const newSubtaskInput = document.getElementById('newSubtaskInput');

    populateSubjectDropdowns();
    customSubjectInput.classList.add('hidden');
    subjectSelect.classList.remove('hidden');
    newSubtaskInput.value = '';

    if (editTask) {
      titleEl.textContent = 'Редактировать задание';
      editIdInput.value = editTask.id;
      subjectSelect.value = editTask.subject;
      daySelect.value = String(editTask.dayOfWeek);
      prioritySelect.value = editTask.priority || 'normal';
      taskTitleInput.value = editTask.title;
      taskTypeSelect.value = editTask.type || 'Практика / ДЗ';
      taskDeadlineInput.value = editTask.deadline || '';
      taskLinkInput.value = editTask.link || '';
      taskNotesInput.value = editTask.notes || '';
      editingSubtasks = Array.isArray(editTask.subtasks)
        ? editTask.subtasks.map((s) => ({ ...s }))
        : [];
    } else {
      titleEl.textContent = 'Новое задание';
      editIdInput.value = '';
      if (subject) {
        const exists = Array.from(subjectSelect.options).some((opt) => opt.value === subject);
        if (!exists) {
          const opt = document.createElement('option');
          opt.value = subject;
          opt.textContent = subject;
          subjectSelect.appendChild(opt);
        }
        subjectSelect.value = subject;
      }
      daySelect.value = String(dayOfWeek || 1);
      prioritySelect.value = 'normal';
      taskTitleInput.value = '';
      taskTypeSelect.value = 'Практика / ДЗ';
      taskDeadlineInput.value = '';
      taskLinkInput.value = '';
      taskNotesInput.value = '';
      editingSubtasks = [];
    }

    renderSubtasksEditorInModal();
    updateTaskDayMatchHint();
    modal.classList.remove('hidden');
    taskTitleInput.focus();
  }

  function updateTaskDayMatchHint() {
    const subjectSelect = document.getElementById('taskSubjectSelect');
    const customInput = document.getElementById('taskCustomSubjectInput');
    const hintEl = document.getElementById('taskDayMatchHint');
    if (!hintEl) return;
    const selectedSubject = !customInput.classList.contains('hidden')
      ? customInput.value.trim()
      : subjectSelect.value;

    const subjectDays = Array.from(
      new Set(
        appState.lessons
          .filter((l) => l.subject.toLowerCase().trim() === selectedSubject.toLowerCase().trim())
          .map((l) => Number(l.dayOfWeek))
      )
    ).sort((a, b) => a - b);

    if (subjectDays.length > 0) {
      const names = subjectDays
        .map((id) => DAYS_OF_WEEK.find((d) => d.id === id)?.short)
        .filter(Boolean);
      hintEl.textContent = `Дни этого предмета: ${names.join(', ')}`;
    } else {
      hintEl.textContent = '';
    }
  }

  function buildEveningSummaryMessage() {
    const { tomorrowId } = getTodayAndTomorrowDays();
    const tomorrowObj = DAYS_OF_WEEK.find((d) => d.id === tomorrowId);
    const tomorrowLessons = appState.lessons.filter((l) => Number(l.dayOfWeek) === tomorrowId);
    const tomorrowTasks = appState.tasks.filter(
      (t) => !t.completed && Number(t.dayOfWeek) === tomorrowId
    );

    const dayLabel = tomorrowObj ? tomorrowObj.name : 'Завтра';
    const classesPart =
      tomorrowLessons.length > 0
        ? `На завтра (${dayLabel}) ${tomorrowLessons.length} ${pluralize(
            tomorrowLessons.length,
            'пара',
            'пары',
            'пар'
          )} (1-я в ${tomorrowLessons[0].startTime}).`
        : `Завтра (${dayLabel}) по расписанию выходной.`;

    const tasksPart =
      tomorrowTasks.length > 0
        ? `Невыполненных заданий: ${tomorrowTasks.length}.`
        : 'Все задания на завтра выполнены!';

    return `${classesPart} ${tasksPart}`;
  }

  async function triggerBrowserNotification(title, body) {
    if (!('Notification' in window)) {
      showToast(body);
      return;
    }

    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }

    if (Notification.permission === 'granted') {
      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg && reg.showNotification) {
            await reg.showNotification(title, {
              body,
              icon: 'icon.svg',
              badge: 'icon.svg'
            });
            return;
          }
        }
        new Notification(title, { body, icon: 'icon.svg' });
      } catch (_) {
        showToast(`${title}: ${body}`);
      }
    } else {
      showToast(`${title}: ${body}`);
    }
  }

  function checkScheduledEveningReminder() {
    if (!reminderSettings.enabled || !reminderSettings.time) return;
    const now = new Date();
    const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(
      now.getMinutes()
    ).padStart(2, '0')}`;
    const todayIso = now.toISOString().slice(0, 10);

    if (
      currentHHMM === reminderSettings.time &&
      reminderSettings.lastNotifiedDate !== todayIso
    ) {
      reminderSettings.lastNotifiedDate = todayIso;
      saveReminderSettings(reminderSettings);
      const body = buildEveningSummaryMessage();
      triggerBrowserNotification('🎓 HEMIS Planner — На завтра', body);
    }
  }

  function initPwaAndServiceWorker() {
    if ('serviceWorker' in navigator && /^https?:$/i.test(window.location.protocol)) {
      navigator.serviceWorker
        .register('./sw.js?v=4')
        .then((reg) => {
          reg.update();
        })
        .catch(() => {});
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPwaPrompt = e;
      const installBtn = document.getElementById('btnInstallPwaPrompt');
      if (installBtn) installBtn.classList.remove('hidden');
    });

    const installBtn = document.getElementById('btnInstallPwaPrompt');
    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        if (!deferredPwaPrompt) return;
        deferredPwaPrompt.prompt();
        await deferredPwaPrompt.userChoice;
        deferredPwaPrompt = null;
        installBtn.classList.add('hidden');
      });
    }
  }

  function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const isMatch = b.dataset.tab === tabName;
      b.classList.toggle('active', isMatch);
      b.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });

    document
      .getElementById('tabContentSchedule')
      .classList.toggle('hidden', tabName !== 'schedule');
    document.getElementById('tabContentTasks').classList.toggle('hidden', tabName !== 'tasks');
    document
      .getElementById('tabContentSubjects')
      .classList.toggle('hidden', tabName !== 'subjects');
    document
      .getElementById('weekDaysStrip')
      .classList.toggle('hidden', tabName !== 'schedule');
    document
      .getElementById('scheduleFilters')
      .classList.toggle('hidden', tabName !== 'schedule');
  }

  function pluralize(count, one, few, many) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  function initEventListeners() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.tab);
      });
    });

    const savedTheme = localStorage.getItem('hemis_planner_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    document.getElementById('btnThemeToggle').addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('hemis_planner_theme', next);
    });

    document
      .getElementById('chkHideCompletedInline')
      .addEventListener('change', renderScheduleByDays);

    document.getElementById('taskSearchInput').addEventListener('input', renderAllTasksTab);
    document.getElementById('taskSubjectFilter').addEventListener('change', renderAllTasksTab);
    document.getElementById('taskStatusFilter').addEventListener('change', renderAllTasksTab);

    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const modalId = btn.getAttribute('data-close-modal');
        document.getElementById(modalId)?.classList.add('hidden');
      });
    });

    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.classList.add('hidden');
      });
    });

    const openHemisModal = () => {
      const modal = document.getElementById('modalHemis');
      document.getElementById('hemisConnectionStatus').classList.add('hidden');
      if (hemisConfig.login) {
        document.getElementById('hemisLoginInput').value = hemisConfig.login;
      }
      if (hemisConfig.token) {
        document.getElementById('hemisTokenInput').value = hemisConfig.token;
      }
      modal.classList.remove('hidden');
    };

    document.getElementById('btnOpenHemisModal').addEventListener('click', openHemisModal);
    document.getElementById('btnEmptyConnectHemis').addEventListener('click', openHemisModal);

    document.getElementById('hemisUniSelect').addEventListener('change', (e) => {
      const isCustom = e.target.value === 'custom';
      document.getElementById('customUniUrlGroup').classList.toggle('hidden', !isCustom);
    });

    document.querySelectorAll('[data-hemis-mode]').forEach((pill) => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('[data-hemis-mode]').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        currentHemisMode = pill.getAttribute('data-hemis-mode');

        document
          .getElementById('hemisModeCredentials')
          .classList.toggle('hidden', currentHemisMode !== 'credentials');
        document
          .getElementById('hemisModeToken')
          .classList.toggle('hidden', currentHemisMode !== 'token');
        document
          .getElementById('hemisModeJson')
          .classList.toggle('hidden', currentHemisMode !== 'json');
      });
    });

    const loadDemoHandler = () => {
      const demo = getDemoHemisData();
      appState.studentProfile = demo.studentProfile;
      appState.lessons = demo.lessons;
      appState.attendance = demo.attendance;
      if (appState.tasks.length === 0) {
        appState.tasks = demo.sampleTasks;
      }
      activeDayFilter = 'all';
      persistState();
      document.getElementById('modalHemis').classList.add('hidden');
      showToast('Загружены демо-данные!');
    };

    document.getElementById('btnLoadDemoSchedule').addEventListener('click', loadDemoHandler);
    document.getElementById('btnModalDemoSchedule').addEventListener('click', loadDemoHandler);

    document.getElementById('hemisConnectForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const statusBox = document.getElementById('hemisConnectionStatus');
      const submitBtn = document.getElementById('btnSubmitHemis');

      const uniSelectVal = document.getElementById('hemisUniSelect').value;
      const baseUrl =
        uniSelectVal === 'custom'
          ? document.getElementById('hemisCustomUrl').value.trim()
          : uniSelectVal;

      statusBox.className = 'alert-box info';
      statusBox.textContent = 'Загружаем расписание и пропуски (НБ) из HEMIS...';
      statusBox.classList.remove('hidden');
      submitBtn.disabled = true;

      try {
        if (currentHemisMode === 'json') {
          const rawText = document.getElementById('hemisRawJsonInput').value.trim();
          if (!rawText) throw new Error('Вставьте JSON-ответ расписания.');
          const parsedJson = JSON.parse(rawText);
          const lessons = normalizeHemisSchedulePayload(parsedJson);
          appState.lessons = lessons;
          appState.studentProfile = {
            fullName: 'Импорт JSON',
            groupName: '',
            semesterName: '',
            university: baseUrl
          };
          persistState();
          document.getElementById('modalHemis').classList.add('hidden');
          showToast(`Загружено пар: ${lessons.length}`);
        } else {
          let token = '';
          if (currentHemisMode === 'credentials') {
            const login = document.getElementById('hemisLoginInput').value.trim();
            const password = document.getElementById('hemisPasswordInput').value;
            if (!login || !password) {
              throw new Error('Введите логин и пароль от HEMIS.');
            }
            token = await loginToHemis(baseUrl, login, password, true);
            hemisConfig = { baseUrl, login, token, useCorsProxy: true };
            saveHemisAuthConfig(hemisConfig);
          } else {
            token = document.getElementById('hemisTokenInput').value.trim();
            if (!token) throw new Error('Введите Bearer токен.');
            hemisConfig = { baseUrl, login: hemisConfig.login || '', token, useCorsProxy: true };
            saveHemisAuthConfig(hemisConfig);
          }

          const { studentProfile, lessons, attendance } = await fetchScheduleWithToken(
            baseUrl,
            token,
            true
          );
          appState.studentProfile = studentProfile || {
            fullName: hemisConfig.login || 'Студент',
            groupName: '',
            semesterName: '',
            university: baseUrl
          };
          appState.lessons = lessons;
          if (attendance && Object.keys(attendance).length > 0) {
            appState.attendance = attendance;
          }
          persistState();
          document.getElementById('modalHemis').classList.add('hidden');
          showToast(`Расписание обновлено (${lessons.length} пар)!`);
        }
      } catch (err) {
        statusBox.className = 'alert-box error';
        statusBox.textContent = `Ошибка: ${err.message}`;
      } finally {
        submitBtn.disabled = false;
      }
    });

    document.getElementById('btnRefreshSchedule').addEventListener('click', async () => {
      if (!hemisConfig.token || !hemisConfig.baseUrl) {
        openHemisModal();
        return;
      }
      try {
        showToast('Обновляем данные из HEMIS...');
        const { studentProfile, lessons, attendance } = await fetchScheduleWithToken(
          hemisConfig.baseUrl,
          hemisConfig.token,
          true
        );
        if (studentProfile) appState.studentProfile = studentProfile;
        appState.lessons = lessons;
        if (attendance && Object.keys(attendance).length > 0) {
          appState.attendance = attendance;
        }
        persistState();
        showToast('Расписание и НБ обновлены!');
      } catch (err) {
        openHemisModal();
      }
    });

    document.getElementById('btnQuickAddTask').addEventListener('click', () => {
      const { todayId } = getTodayAndTomorrowDays();
      openTaskModal({ dayOfWeek: todayId <= 6 ? todayId : 1 });
    });
    document.getElementById('btnAddTaskFromList').addEventListener('click', () => {
      const { todayId } = getTodayAndTomorrowDays();
      openTaskModal({ dayOfWeek: todayId <= 6 ? todayId : 1 });
    });

    document.getElementById('btnToggleCustomSubject').addEventListener('click', () => {
      const selectEl = document.getElementById('taskSubjectSelect');
      const customEl = document.getElementById('taskCustomSubjectInput');
      const isCustomHidden = customEl.classList.contains('hidden');
      customEl.classList.toggle('hidden', !isCustomHidden);
      selectEl.classList.toggle('hidden', isCustomHidden);
      if (isCustomHidden) customEl.focus();
    });

    document.getElementById('taskSubjectSelect').addEventListener('change', (e) => {
      updateTaskDayMatchHint();
      const subj = e.target.value;
      const matchingLesson = appState.lessons.find(
        (l) => l.subject.toLowerCase().trim() === subj.toLowerCase().trim()
      );
      if (matchingLesson && !document.getElementById('taskEditId').value) {
        document.getElementById('taskDayOfWeekSelect').value = String(matchingLesson.dayOfWeek);
      }
    });

    const addSubtaskFromInput = () => {
      const input = document.getElementById('newSubtaskInput');
      const text = input.value.trim();
      if (!text) return;
      editingSubtasks.push({
        id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        text,
        done: false
      });
      input.value = '';
      renderSubtasksEditorInModal();
      input.focus();
    };

    document.getElementById('btnAddSubtask').addEventListener('click', addSubtaskFromInput);
    document.getElementById('newSubtaskInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSubtaskFromInput();
      }
    });

    document.getElementById('taskForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const editId = document.getElementById('taskEditId').value;
      const selectEl = document.getElementById('taskSubjectSelect');
      const customEl = document.getElementById('taskCustomSubjectInput');

      const pendingSubText = document.getElementById('newSubtaskInput').value.trim();
      if (pendingSubText) {
        editingSubtasks.push({
          id: `sub_${Date.now()}_auto`,
          text: pendingSubText,
          done: false
        });
      }

      const subject =
        !customEl.classList.contains('hidden') && customEl.value.trim()
          ? customEl.value.trim()
          : selectEl.value.trim() || 'Общий предмет';

      const dayOfWeek = Number(document.getElementById('taskDayOfWeekSelect').value) || 1;
      const priority = document.getElementById('taskPrioritySelect').value;
      const title = document.getElementById('taskTitleInput').value.trim();
      const type = document.getElementById('taskTypeSelect').value;
      const deadline = document.getElementById('taskDeadlineInput').value;
      const link = document.getElementById('taskLinkInput').value.trim();
      const notes = document.getElementById('taskNotesInput').value.trim();

      if (!title) return;

      if (editId) {
        const idx = appState.tasks.findIndex((t) => t.id === editId);
        if (idx !== -1) {
          appState.tasks[idx] = {
            ...appState.tasks[idx],
            subject,
            dayOfWeek,
            priority,
            title,
            type,
            deadline,
            link,
            notes,
            subtasks: editingSubtasks
          };
        }
        showToast('Задание обновлено');
      } else {
        appState.tasks.unshift({
          id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          subject,
          dayOfWeek,
          priority,
          title,
          type,
          deadline,
          link,
          notes,
          subtasks: editingSubtasks,
          completed: false,
          createdAt: Date.now()
        });
        showToast('Задание добавлено');
      }

      document.getElementById('modalTask').classList.add('hidden');
      persistState();
    });

    document.getElementById('btnOpenReminders').addEventListener('click', () => {
      reminderSettings = loadReminderSettings();
      document.getElementById('chkEnableEveningReminders').checked = Boolean(
        reminderSettings.enabled
      );
      document.getElementById('reminderTimeInput').value = reminderSettings.time || '20:00';
      document.getElementById('modalReminders').classList.remove('hidden');
    });

    document.getElementById('remindersForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const enabled = document.getElementById('chkEnableEveningReminders').checked;
      const time = document.getElementById('reminderTimeInput').value || '20:00';

      if (enabled && 'Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
      }

      reminderSettings = { ...reminderSettings, enabled, time };
      saveReminderSettings(reminderSettings);
      updateReminderStatusIndicator();
      document.getElementById('modalReminders').classList.add('hidden');
      showToast(enabled ? `Напоминания включены на ${time}` : 'Напоминания выключены');
    });

    document.getElementById('btnTestNotification').addEventListener('click', async () => {
      const summary = buildEveningSummaryMessage();
      await triggerBrowserNotification('🎓 HEMIS Planner', summary);
      showToast(summary);
    });

    const openManualLessonModal = () => {
      document.getElementById('manualLessonForm').reset();
      document.getElementById('modalManualLesson').classList.remove('hidden');
    };
    document.getElementById('btnAddManualLesson').addEventListener('click', openManualLessonModal);
    document.getElementById('btnEmptyAddManual').addEventListener('click', openManualLessonModal);

    document.getElementById('manualLessonForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const subject = document.getElementById('manualSubjectInput').value.trim();
      const dayOfWeek = Number(document.getElementById('manualDaySelect').value) || 1;
      const [pairNum, startTime, endTime] = document
        .getElementById('manualPairSelect')
        .value.split('|');
      const trainingType = document.getElementById('manualTrainingTypeSelect').value;
      const room = document.getElementById('manualRoomInput').value.trim() || '—';
      const teacher = document.getElementById('manualTeacherInput').value.trim() || 'Преподаватель';

      appState.lessons.push({
        id: `manual_${Date.now()}`,
        dayOfWeek,
        subject,
        trainingType,
        pairName: `${pairNum} пара`,
        startTime,
        endTime,
        room,
        teacher
      });

      document.getElementById('modalManualLesson').classList.add('hidden');
      persistState();
      showToast(`Пара «${subject}» добавлена`);
    });

    // Глобальное делегирование кликов
    document.body.addEventListener('click', (e) => {
      const removeSubBtn = e.target.closest('[data-remove-editor-subtask]');
      if (removeSubBtn) {
        const subId = removeSubBtn.getAttribute('data-remove-editor-subtask');
        editingSubtasks = editingSubtasks.filter((s) => s.id !== subId);
        renderSubtasksEditorInModal();
        return;
      }

      // Фильтр по дню недели в 1 клик
      const filterDayBtn = e.target.closest('[data-filter-day]');
      if (filterDayBtn) {
        const val = filterDayBtn.getAttribute('data-filter-day');
        activeDayFilter = val === 'all' ? 'all' : Number(val);
        switchTab('schedule');
        renderHeaderAndMetrics();
        renderScheduleByDays();
        return;
      }

      // Переход к вкладке пропусков НБ при клике на пилюлю НБ в расписании
      const openNbBtn = e.target.closest('[data-open-nb-tab]');
      if (openNbBtn) {
        switchTab('subjects');
        return;
      }

      const nbBtn = e.target.closest('[data-nb-delta]');
      if (nbBtn) {
        const subj = nbBtn.getAttribute('data-nb-subject');
        const delta = Number(nbBtn.getAttribute('data-nb-delta')) || 0;
        adjustSubjectMissedHours(subj, delta);
        return;
      }

      const addTaskBtn = e.target.closest('[data-add-task-subject]');
      if (addTaskBtn) {
        const subject = addTaskBtn.getAttribute('data-add-task-subject');
        const dayOfWeek = Number(addTaskBtn.getAttribute('data-add-task-day')) || 1;
        openTaskModal({ subject, dayOfWeek });
        return;
      }

      const quickCompleteBtn = e.target.closest('[data-quick-complete]');
      if (quickCompleteBtn) {
        const taskId = quickCompleteBtn.getAttribute('data-quick-complete');
        const task = appState.tasks.find((t) => t.id === taskId);
        if (task) {
          task.completed = true;
          persistState();
          showToast('Задание выполнено!');
        }
        return;
      }

      const editBtn = e.target.closest('[data-edit-task]');
      if (editBtn) {
        const taskId = editBtn.getAttribute('data-edit-task');
        const task = appState.tasks.find((t) => t.id === taskId);
        if (task) openTaskModal({ editTask: task });
        return;
      }

      const deleteBtn = e.target.closest('[data-delete-task]');
      if (deleteBtn) {
        const taskId = deleteBtn.getAttribute('data-delete-task');
        appState.tasks = appState.tasks.filter((t) => t.id !== taskId);
        persistState();
        showToast('Задание удалено');
        return;
      }

      const deleteLessonBtn = e.target.closest('[data-delete-lesson]');
      if (deleteLessonBtn) {
        const lessonId = deleteLessonBtn.getAttribute('data-delete-lesson');
        appState.lessons = appState.lessons.filter((l) => l.id !== lessonId);
        persistState();
        showToast('Пара удалена');
      }
    });

    document.body.addEventListener('change', (e) => {
      const checkbox = e.target.closest('[data-toggle-task]');
      if (checkbox) {
        const taskId = checkbox.getAttribute('data-toggle-task');
        const task = appState.tasks.find((t) => t.id === taskId);
        if (task) {
          task.completed = checkbox.checked;
          persistState();
        }
        return;
      }

      const subtaskChk = e.target.closest('[data-toggle-subtask]');
      if (subtaskChk) {
        const subId = subtaskChk.getAttribute('data-toggle-subtask');
        const parentId = subtaskChk.getAttribute('data-parent-task');
        const task = appState.tasks.find((t) => t.id === parentId);
        if (task && Array.isArray(task.subtasks)) {
          const sub = task.subtasks.find((s) => s.id === subId);
          if (sub) {
            sub.done = subtaskChk.checked;
            if (task.subtasks.length > 0 && task.subtasks.every((s) => s.done)) {
              task.completed = true;
              showToast('Все шаги выполнены — задание закрыто!');
            }
            persistState();
          }
        }
        return;
      }

      const hoursSelect = e.target.closest('[data-subject-hours]');
      if (hoursSelect) {
        const subj = hoursSelect.getAttribute('data-subject-hours');
        setSubjectTotalHours(subj, Number(hoursSelect.value));
      }
    });

    // Модальное окно Облачной синхронизации (По ID и паролю)
    document.getElementById('btnCloudSync').addEventListener('click', () => {
      cloudConfig = loadCloudConfig();
      document.getElementById('quickSyncIdInput').value =
        cloudConfig.quickId || hemisConfig.login || '';
      document.getElementById('quickSyncPinInput').value = cloudConfig.quickPin || '';
      document.getElementById('cloudSyncMessage').classList.add('hidden');
      document.getElementById('modalCloudSync').classList.remove('hidden');
    });

    const readCloudFormValues = () => ({
      provider: 'quick',
      quickId: document.getElementById('quickSyncIdInput')?.value.trim() || '',
      quickPin: document.getElementById('quickSyncPinInput')?.value.trim() || ''
    });

    document.getElementById('cloudSyncForm').addEventListener('submit', (e) => {
      e.preventDefault();
      cloudConfig = saveCloudConfig(readCloudFormValues());
      updateCloudStatusIndicator();
      showToast('ID и пароль синхронизации сохранены!');
      document.getElementById('modalCloudSync').classList.add('hidden');
    });

    document.getElementById('btnPushToCloud').addEventListener('click', async () => {
      const msgBox = document.getElementById('cloudSyncMessage');
      cloudConfig = saveCloudConfig(readCloudFormValues());

      msgBox.className = 'alert-box info';
      msgBox.textContent = 'Сохраняем ваше расписание и задания в облако...';
      msgBox.classList.remove('hidden');

      try {
        await pushStateToCloud(appState, cloudConfig);
        msgBox.className = 'alert-box success';
        msgBox.textContent = `Успешно сохранено! Теперь на телефоне введите ID «${cloudConfig.quickId}» и этот же пароль, и нажмите «⬇ Загрузить из облака».`;
        updateCloudStatusIndicator(true);
      } catch (err) {
        msgBox.className = 'alert-box error';
        msgBox.textContent = `Ошибка: ${err.message}`;
      }
    });

    document.getElementById('btnPullFromCloud').addEventListener('click', async () => {
      const msgBox = document.getElementById('cloudSyncMessage');
      cloudConfig = saveCloudConfig(readCloudFormValues());

      msgBox.className = 'alert-box info';
      msgBox.textContent = 'Загружаем ваши данные из облака...';
      msgBox.classList.remove('hidden');

      try {
        appState = await pullStateFromCloud(cloudConfig);
        renderAll();
        msgBox.className = 'alert-box success';
        msgBox.textContent = `Данные загружены (пар: ${appState.lessons.length}, заданий: ${appState.tasks.length})!`;
        updateCloudStatusIndicator(true);
      } catch (err) {
        msgBox.className = 'alert-box error';
        msgBox.textContent = `Ошибка: ${err.message}`;
      }
    });

    document.getElementById('btnExportJson').addEventListener('click', () => {
      exportStateToJsonFile(appState);
      showToast('Резервная копия (.json) скачана');
    });

    document.getElementById('importJsonFileInput').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          if (!Array.isArray(parsed.lessons) && !Array.isArray(parsed.tasks)) {
            throw new Error('Некорректный формат файла.');
          }
          appState = saveLocalState(parsed);
          renderAll();
          document.getElementById('modalCloudSync').classList.add('hidden');
          showToast('Данные из файла восстановлены!');
        } catch (err) {
          alert(`Ошибка чтения файла: ${err.message}`);
        }
      };
      reader.readAsText(file);
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    initEventListeners();
    initPwaAndServiceWorker();
    renderAll();

    setInterval(renderLiveClassTimer, 1000);
    setInterval(checkScheduledEveningReminder, 25000);

    if (isCloudConfigured(cloudConfig)) {
      try {
        const remote = await pullStateFromCloud(cloudConfig);
        if (remote && (remote.lessons?.length || remote.tasks?.length)) {
          appState = remote;
          renderAll();
        }
      } catch (_) {}
    }
  });
})(window);
