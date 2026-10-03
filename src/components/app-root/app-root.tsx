import { Component, Host, State, h, Listen } from '@stencil/core';
import {
  captionSafeWithCamera,
  cloneProject,
  createDemoProject,
  footageById,
  ingestReturns,
  isKnownCamera,
  markFootage,
  migrateShootDomain,
  openShootTask,
  rejudgeTaskSafety,
  retryReturns,
  selectedModule,
  selectedStep,
  STORAGE_KEY,
  taskForStep,
  validateProject,
  type CameraAngle,
  type CaptionPosition,
  type CourseModule,
  type CourseProject,
  type Difficulty,
  type GestureZone,
  type LessonStep,
  type ShootTask,
  type ValidationCheck,
} from '../../models';

type PreviewSize = 'phone' | 'tablet';
type StudioRole = 'teacher' | 'crew';
const ROLE_KEY = 'sologsb-1012-role';

@Component({
  tag: 'app-root',
  styleUrl: 'app-root.css',
  scoped: true,
})
export class AppRoot {
  @State() project: CourseProject = createDemoProject();
  @State() previewSize: PreviewSize = 'phone';
  @State() activePanel: 'editor' | 'checks' | 'shoot' = 'editor';
  @State() role: StudioRole = (typeof localStorage !== 'undefined' && localStorage.getItem(ROLE_KEY) === 'crew') ? 'crew' : 'teacher';
  @State() playing = false;
  @State() playProgress = 0;
  @State() offline = typeof navigator !== 'undefined' ? !navigator.onLine : false;
  @State() toast?: { color: string; message: string };
  @State() returnDraft = '';
  private past: CourseProject[] = [];
  private future: CourseProject[] = [];
  private playTimer?: number;

  componentWillLoad(): void {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const migrated = migrateShootDomain(JSON.parse(saved) as CourseProject);
        this.project = migrated;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      }
    } catch {
      this.project = createDemoProject();
    }
  }

  disconnectedCallback(): void {
    if (this.playTimer) window.clearInterval(this.playTimer);
  }

  @Listen('online', { target: 'window' })
  handleOnline(): void {
    this.offline = false;
    this.showToast('success', '网络已恢复，本地草稿无需合并即可继续编辑。');
  }

  @Listen('offline', { target: 'window' })
  handleOffline(): void {
    this.offline = true;
    this.showToast('warning', '当前处于离线状态，修改会继续保存在本机。');
  }

  @Listen('keydown', { target: 'window' })
  handleKeyboard(event: KeyboardEvent): void {
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName);
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (this.role !== 'teacher') return;
    if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.saveDraft(true);
      return;
    }
    if (!editing && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      this.moveStep(event.key === 'ArrowUp' ? -1 : 1);
    }
  }

  private get currentModule(): CourseModule {
    return selectedModule(this.project);
  }

  private get currentStep(): LessonStep | undefined {
    return selectedStep(this.project);
  }

  private get checks(): ValidationCheck[] {
    return validateProject(this.project);
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.project));
  }

  private commit(update: (draft: CourseProject) => CourseProject, toast?: string): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '当前版本已冻结，请先创建修订版。');
      return;
    }
    const before = cloneProject(this.project);
    const next = update(cloneProject(this.project));
    next.revision = before.revision + 1;
    next.lastSavedAt = new Date().toISOString();
    this.past = [...this.past, before].slice(-80);
    this.future = [];
    this.project = next;
    this.persist();
    if (toast) this.showToast('success', toast);
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous) return this.showToast('medium', '没有可撤销的修改。');
    this.future = [cloneProject(this.project), ...this.future].slice(0, 80);
    this.project = previous;
    this.persist();
  }

  private redo(): void {
    const next = this.future.shift();
    if (!next) return;
    this.past = [...this.past, cloneProject(this.project)].slice(-80);
    this.project = next;
    this.persist();
  }

  private switchRole(role: StudioRole): void {
    this.role = role;
    localStorage.setItem(ROLE_KEY, role);
    this.activePanel = role === 'crew' ? 'shoot' : 'editor';
    this.showToast('success', role === 'crew' ? '已切换到拍摄组工作台：只管拍摄任务与素材回传。' : '已切换到教师工作台：课程模块与学习步骤由教师维护。');
  }

  /** 教师每加一个示范步骤，就开一条拍摄任务。 */
  private openTaskForStep(stepId: string): void {
    this.commit((draft) => openShootTask(draft, stepId), '已开出新的拍摄任务。');
  }

  private handleMarkFootage(footageId: string, state: '停用' | '重拍'): void {
    this.commit((draft) => { markFootage(draft, footageId, state); return draft; }, `素材已标记为${state}，引用步骤进入待确认。`);
  }

  private handleRejudge(taskCode: string): void {
    this.commit((draft) => {
      rejudgeTaskSafety(draft, taskCode);
      return draft;
    }, '已按新素材与当前字幕位置重新判定安全区。');
  }

  private submitReturns(raw: string): void {
    const entries = raw.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [taskCode, camera, assetUrl, clipName] = line.split(/[,，\t]/).map((part) => part?.trim() ?? '');
      return { taskCode, camera, assetUrl, clipName };
    }).filter((entry) => entry.taskCode || entry.assetUrl);
    if (!entries.length) return this.showToast('warning', '请按「任务编号, 机位, 素材地址」每行一条填写回传。');
    const draft = cloneProject(this.project);
    const result = ingestReturns(draft, entries);
    this.applyShootDraft(draft);
    if (result.adopted.length) this.showToast('success', `${result.adopted.length} 条回传对号入库${result.pending.length ? `；${result.pending.length} 条安全区不达标已挂待确认` : ''}。`);
    else if (result.pending.length) this.showToast('warning', `${result.pending.length} 条回传安全区不达标，已挂待确认。`);
    if (result.suspended.length) window.setTimeout(() => this.showToast('danger', `${result.suspended.length} 条对不上，仅挂起这几条，可在下方逐条重试。`), result.adopted.length || result.pending.length ? 400 : 0);
    this.returnDraft = '';
  }

  private retryReturn(code?: string): void {
    const draft = cloneProject(this.project);
    const result = retryReturns(draft, code ? [code] : undefined);
    this.applyShootDraft(draft);
    if (result.adopted.length || result.pending.length) this.showToast('success', `重试完成：入库 ${result.adopted.length} 条，待确认 ${result.pending.length} 条，仍挂起 ${result.suspended.length} 条。`);
    else this.showToast('warning', '重试仍对不上，条目继续挂起，其它回传不受影响。');
  }

  private applyShootDraft(next: CourseProject): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '当前版本已冻结，请先创建修订版。');
      return;
    }
    const before = cloneProject(this.project);
    next.revision = before.revision + 1;
    next.lastSavedAt = new Date().toISOString();
    this.past = [...this.past, before].slice(-80);
    this.future = [];
    this.project = next;
    this.persist();
  }

  private showToast(color: string, message: string): void {
    this.toast = { color, message };
    window.setTimeout(() => {
      if (this.toast?.message === message) this.toast = undefined;
    }, 3_200);
  }

  private selectModule(moduleId: string): void {
    const module = this.project.modules.find((item) => item.id === moduleId);
    this.project = { ...this.project, selectedModuleId: moduleId, selectedStepId: module?.steps[0]?.id ?? '' };
    this.persist();
  }

  private selectStep(stepId: string): void {
    this.project = { ...this.project, selectedStepId: stepId };
    this.persist();
  }

  private updateStep(patch: Partial<LessonStep>, toast?: string): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    this.commit((draft) => {
      const modules = draft.modules.map((module) => module.id === draft.selectedModuleId ? {
        ...module,
        steps: module.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step),
      } : module);
      // 教师改示范片段名称时，同步该步骤绑定拍摄任务上的名称。
      const shootTasks = patch.demoTitle === undefined ? draft.shootTasks : draft.shootTasks.map((task) => {
        const owned = modules.some((module) => module.steps.some((step) => step.id === stepId && step.shootTaskCode === task.code));
        return owned ? { ...task, clipName: patch.demoTitle ?? task.clipName } : task;
      });
      return { ...draft, modules, shootTasks };
    }, toast);
  }

  private updateCurrentModule(patch: Partial<CourseModule>): void {
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? { ...module, ...patch } : module),
    }));
  }

  private addModule(): void {
    const index = this.project.modules.length + 1;
    const module: CourseModule = {
      id: `module-${Date.now().toString(36)}`,
      title: `模块 ${index} · 未命名`,
      summary: '说明该模块的学习目标与适用场景。',
      color: ['#15827a', '#8a3ffc', '#b34331', '#376ea8'][index % 4],
      steps: [],
    };
    this.commit((draft) => ({ ...draft, modules: [...draft.modules, module], selectedModuleId: module.id, selectedStepId: '' }), '已创建课程模块。');
  }

  private addStep(kind: LessonStep['kind'] = '示范'): void {
    const module = this.currentModule;
    if (!module) return this.addModule();
    const prior = module.steps.at(-1);
    const step: LessonStep = {
      id: `step-${Date.now().toString(36)}`,
      title: `新${kind}步骤 ${module.steps.length + 1}`,
      kind,
      duration: 45,
      demoTitle: '等待上传或录制示范片段',
      demoUrl: '',
      handshape: '描述起始手形、掌心方向和运动路径。',
      gestureZone: '中央',
      caption: '填写送给学习者的字幕说明。',
      captionPosition: '下方安全区',
      camera: '正面',
      commonMistakes: [],
      exercise: kind === '练习' ? '填写练习任务。' : '',
      exerciseFeedback: kind === '练习' ? '填写反馈方式。' : '',
      altText: '',
      prerequisiteId: prior?.id ?? '',
      difficulty: '入门',
      cuePoints: [8, 20, 32],
    };
    // 教师每加一个示范步骤就开一条拍摄任务。
    this.commit((draft) => {
      const withStep: CourseProject = {
        ...draft,
        modules: draft.modules.map((item) => item.id === module.id ? { ...item, steps: [...item.steps, step] } : item),
        selectedStepId: step.id,
      };
      return kind === '示范' ? openShootTask(withStep, step.id) : withStep;
    }, kind === '示范' ? '已新增示范步骤，并开出拍摄任务。' : '已新增学习步骤。');
  }

  private duplicateStep(): void {
    const step = this.currentStep;
    if (!step) return;
    this.commit((draft) => {
      const moduleIndex = draft.modules.findIndex((module) => module.id === draft.selectedModuleId);
      const target = draft.modules[moduleIndex];
      const index = target.steps.findIndex((item) => item.id === step.id);
      const copy: LessonStep = {
        ...structuredClone(step),
        id: `step-${Date.now().toString(36)}`,
        title: `${step.title}（副本）`,
        shootTaskCode: undefined,
        materialId: undefined,
        demoUrl: '',
      };
      const modules = [...draft.modules];
      modules[moduleIndex] = { ...target, steps: [...target.steps.slice(0, index + 1), copy, ...target.steps.slice(index + 1)] };
      const inserted: CourseProject = { ...draft, modules, selectedStepId: copy.id };
      return copy.kind === '示范' ? openShootTask(inserted, copy.id) : inserted;
    }, '已复制当前步骤。');
  }

  private deleteStep(stepId: string): void {
    if (this.currentModule.steps.length <= 1) {
      this.showToast('warning', '模块至少保留一个学习步骤。');
      return;
    }
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? {
        ...module,
        steps: module.steps.filter((step) => step.id !== stepId),
      } : module),
      selectedStepId: this.currentModule.steps.find((step) => step.id !== stepId)?.id ?? '',
    }), '已删除学习步骤。');
  }

  private moveStep(direction: number): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== draft.selectedModuleId) return module;
        const index = module.steps.findIndex((step) => step.id === stepId);
        const nextIndex = Math.max(0, Math.min(module.steps.length - 1, index + direction));
        if (index === nextIndex) return module;
        const steps = [...module.steps];
        const [item] = steps.splice(index, 1);
        steps.splice(nextIndex, 0, item);
        return { ...module, steps };
      }),
    }), '已调整步骤顺序。');
  }

  private saveDraft(showMessage = true): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '冻结版本不可覆盖，请先创建修订版。');
      return;
    }
    this.project = { ...this.project, status: 'draft', lastSavedAt: new Date().toISOString() };
    this.persist();
    if (showMessage) this.showToast('success', '草稿已保存在浏览器本地。');
  }

  private submitForReview(): void {
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `仍有 ${blocking.length} 个阻断问题，修复后才能提交复核。`);
      return;
    }
    this.commit((draft) => ({ ...draft, status: 'review' }), '课程已提交复核。');
  }

  private returnForChanges(): void {
    this.commit((draft) => ({ ...draft, status: 'changes' }), '课程已退回修改。');
  }

  private freezeVersion(): void {
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `冻结前仍有 ${blocking.length} 个阻断问题。`);
      return;
    }
    this.commit((draft) => {
      const { frozenVersions, ...snapshot } = cloneProject(draft);
      const version = {
        id: `frozen-${Date.now().toString(36)}`,
        label: `冻结版本 v${frozenVersions.length + 1}`,
        createdAt: new Date().toISOString(),
        snapshot,
      };
      return { ...draft, status: 'frozen', frozenVersions: [version, ...frozenVersions] };
    }, '当前课程版本已冻结。');
    this.playing = false;
  }

  private reviseFrozen(): void {
    this.commit((draft) => ({ ...draft, status: 'draft' }), '已创建修订版，可继续编辑。');
  }

  private togglePlay(): void {
    if (this.playTimer) {
      window.clearInterval(this.playTimer);
      this.playTimer = undefined;
      this.playing = false;
      return;
    }
    const duration = Math.max(10, this.currentStep?.duration ?? 40);
    this.playing = true;
    this.playTimer = window.setInterval(() => {
      this.playProgress += 0.25 / duration;
      if (this.playProgress >= 1) {
        this.playProgress = 0;
        this.playing = false;
        if (this.playTimer) window.clearInterval(this.playTimer);
        this.playTimer = undefined;
      }
    }, 250);
  }

  private formatDate(value: string): string {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  private renderStatusBadge() {
    if (this.project.status === 'review') return <ion-badge color="warning">待复核</ion-badge>;
    if (this.project.status === 'changes') return <ion-badge color="danger">已退回</ion-badge>;
    if (this.project.status === 'frozen') return <ion-badge color="success">已冻结</ion-badge>;
    return <ion-badge color="medium">草稿</ion-badge>;
  }

  private renderShootBanner(step: LessonStep, frozen: boolean) {
    const task = taskForStep(this.project, step.id);
    if (!task) {
      return (
        <div class="shoot-callout shoot-missing">
          <div><strong>尚未开出拍摄任务</strong><span>{step.demoTitle.trim() ? '该示范片段没有任务编号，拍摄组无法回传素材。' : '先填写示范片段名称，再开拍摄任务。'}</span></div>
          <ion-button size="small" fill="outline" class="studio-button" disabled={frozen || !step.demoTitle.trim()} onClick={() => this.openTaskForStep(step.id)}>补开拍摄任务</ion-button>
        </div>
      );
    }
    const active = footageById(this.project, task.activeFootageId);
    const pendingFootage = this.project.footageLibrary
      .filter((item) => item.taskCode === task.code && item.state === '回传待判')
      .sort((a, b) => b.returnedAt.localeCompare(a.returnedAt))[0];
    return (
      <div class={`shoot-callout shoot-${task.status === '已确认' ? 'confirmed' : task.status === '待确认' ? 'pending' : 'open'}`}>
        <div class="shoot-callout-head">
          <div>
            <strong><span class="shoot-code">{task.code}</span> · {task.status}</strong>
            <span>拍摄任务绑定示范片段：{task.clipName}</span>
          </div>
          <ion-badge color={task.status === '已确认' ? 'success' : task.status === '待确认' ? 'danger' : 'medium'}>{task.status}</ion-badge>
        </div>
        {active && (
          <div class="shoot-footage-row">
            <div>
              <strong>{active.state === '采用' ? '在库素材' : `素材已${active.state}`}</strong>
              <span>机位 {active.camera} · {active.assetUrl || '未填素材地址'}{active.note ? ` · ${active.note}` : ''}</span>
            </div>
            {active.state === '采用' && (
              <div class="shoot-actions">
                <ion-button size="small" fill="outline" color="warning" class="studio-button" disabled={frozen} onClick={() => this.handleMarkFootage(active.id, '重拍')}>标记重拍</ion-button>
                <ion-button size="small" fill="outline" color="danger" class="studio-button" disabled={frozen} onClick={() => this.handleMarkFootage(active.id, '停用')}>标记停用</ion-button>
              </div>
            )}
          </div>
        )}
        {pendingFootage && (
          <div class="shoot-footage-row">
            <div>
              <strong>新回传素材待教师确认</strong>
              <span>
                机位 {pendingFootage.camera} · {pendingFootage.assetUrl || '未填素材地址'} ·
                {isKnownCamera(pendingFootage.camera) && captionSafeWithCamera(step, pendingFootage.camera)
                  ? ' 当前字幕位置安全区达标，可直接采用'
                  : ' 与当前字幕位置冲突，安全区不达标'}
              </span>
            </div>
            <div class="shoot-actions">
              <ion-button size="small" class="studio-button" disabled={frozen || !isKnownCamera(pendingFootage.camera) || !captionSafeWithCamera(step, pendingFootage.camera)} onClick={() => this.handleRejudge(task.code)}>重新判定并采用</ion-button>
            </div>
          </div>
        )}
        {task.holdReason && <p class="shoot-hold-reason">{task.holdReason}（拍摄组不替教师改步骤）</p>}
      </div>
    );
  }

  private renderCrewBoard() {
    const tasks = this.project.shootTasks;
    const counts = {
      open: tasks.filter((task) => task.status === '拍摄中').length,
      pending: tasks.filter((task) => task.status === '待确认').length,
      confirmed: tasks.filter((task) => task.status === '已确认').length,
    };
    return (
      <div class="crew-board">
        <section class="form-card">
          <div class="section-title"><span>01</span><div><h2>拍摄任务板</h2><p>教师每加一个示范步骤就开出一条任务，拍摄组按编号回传素材与机位</p></div></div>
          <div class="crew-stats">
            <div><strong>{tasks.length}</strong><span>总任务</span></div>
            <div><strong>{counts.open}</strong><span>拍摄中</span></div>
            <div class={counts.pending ? 'has-errors' : ''}><strong>{counts.pending}</strong><span>待教师确认</span></div>
            <div><strong>{counts.confirmed}</strong><span>已确认</span></div>
          </div>
          <div class="crew-task-list">
            {tasks.length === 0 && <p class="crew-empty">教师还没有开出拍摄任务。</p>}
            {tasks.map((task) => this.renderCrewTask(task))}
          </div>
        </section>

        <section class="form-card">
          <div class="section-title"><span>02</span><div><h2>批量回传素材</h2><p>每行一条：任务编号, 机位, 素材地址（可附片段名称）。对不上的条目只挂起这几条。</p></div></div>
          <ion-textarea
            autoGrow
            rows={4}
            class="studio-input return-textarea"
            placeholder={'STG-0001, 正面, assets/hello.mp4\nSTG-0003, 俯拍手部, assets/near.mp4, 多少钱 · 双手组合'}
            value={this.returnDraft}
            onIonInput={(event) => { this.returnDraft = event.detail.value ?? ''; }}
          />
          <div class="crew-return-actions">
            <span>机位清单：正面 / 左侧 45° / 右侧 45° / 俯拍手部 / 全身远景</span>
            <ion-button class="studio-button" disabled={this.project.status === 'frozen'} onClick={() => this.submitReturns(this.returnDraft)}>按编号回传</ion-button>
          </div>
          <p class="crew-boundary-hint">回传只更新素材地址与机位，压不到教师填写的字幕、替代文本与练习。</p>
        </section>

        <section class="form-card">
          <div class="section-title"><span>03</span><div><h2>挂起条目（{this.project.pendingReturns.length}）</h2><p>失败后只重试这几条；对上的条目不受影响。</p></div></div>
          <div class="suspended-list">
            {this.project.pendingReturns.length === 0 && <p class="crew-empty">没有挂起条目。</p>}
            {this.project.pendingReturns.map((item) => (
              <div class="suspended-item" key={item.footage.id}>
                <div>
                  <strong>{item.footage.taskCode}</strong>
                  <span>{item.reason}</span>
                  <small>机位：{item.footage.camera || '(空)'} · 地址：{item.footage.assetUrl || '(空)'} · 已尝试 {item.attempts} 次 · {this.formatDate(item.lastAttemptAt)}</small>
                </div>
                <ion-button size="small" fill="outline" class="studio-button" disabled={this.project.status === 'frozen'} onClick={() => this.retryReturn(item.footage.taskCode)}>重试此条</ion-button>
              </div>
            ))}
            {this.project.pendingReturns.length > 1 && (
              <ion-button fill="clear" class="studio-button crew-retry-all" disabled={this.project.status === 'frozen'} onClick={() => this.retryReturn()}>重试全部挂起条目</ion-button>
            )}
          </div>
        </section>
      </div>
    );
  }

  private renderCrewTask(task: ShootTask) {
    const located = this.findStepLocation(task.stepId);
    const active = footageById(this.project, task.activeFootageId);
    const pending = this.project.footageLibrary.some((item) => item.taskCode === task.code && item.state === '回传待判');
    return (
      <button class={`crew-task status-${task.status === '已确认' ? 'confirmed' : task.status === '待确认' ? 'pending' : 'open'}`} onClick={() => located && this.selectStep(located.step.id)}>
        <span class="shoot-code">{task.code}</span>
        <span class="crew-task-copy">
          <strong>{task.clipName}</strong>
          <small>{located ? `${located.module.title} · ${located.step.title}` : '引用步骤已不存在'}</small>
          {task.holdReason && <small class="crew-hold">{task.holdReason}</small>}
        </span>
        <span class="crew-task-meta">
          <ion-badge color={task.status === '已确认' ? 'success' : task.status === '待确认' ? 'danger' : 'medium'}>{task.status}</ion-badge>
          <small>{active ? `${active.state} · ${active.camera}` : pending ? '有新回传待判' : '尚无回传'}</small>
        </span>
      </button>
    );
  }

  private findStepLocation(stepId: string): { module: CourseModule; step: LessonStep } | undefined {
    for (const module of this.project.modules) {
      const step = module.steps.find((candidate) => candidate.id === stepId);
      if (step) return { module, step };
    }
    return undefined;
  }

  private renderStepListItem(step: LessonStep, index: number) {
    const active = step.id === this.currentStep?.id;
    const issueCount = this.checks.filter((check) => check.stepId === step.id && check.severity !== 'info').length;
    const task = taskForStep(this.project, step.id);
    return (
      <button class={`step-list-item ${active ? 'active' : ''}`} onClick={() => this.selectStep(step.id)}>
        <span class="step-index">{String(index + 1).padStart(2, '0')}</span>
        <span class="step-copy">
          <strong>{step.title}</strong>
          <small>{step.kind} · {step.duration}s · {step.difficulty}{task ? ` · ${task.code} ${task.status}` : ''}</small>
        </span>
        {issueCount > 0 && <span class="step-issue-count">{issueCount}</span>}
      </button>
    );
  }

  private renderStepEditor() {
    const step = this.currentStep;
    if (!step) {
      return (
        <div class="empty-editor">
          <div class="empty-glyph">手</div>
          <h2>这个模块还没有学习步骤</h2>
          <p>添加示范、讲解或练习步骤，然后设置前置条件与难度。</p>
          <ion-button class="studio-button" onClick={() => this.addStep('示范')}>添加第一个步骤</ion-button>
        </div>
      );
    }
    const frozen = this.project.status === 'frozen';
    const module = this.currentModule;
    const prerequisites = module.steps.filter((candidate, index) => candidate.id !== step.id && index < module.steps.findIndex((item) => item.id === step.id));
    return (
      <div class="step-editor">
        <div class="editor-title-row">
          <div>
            <span class="eyebrow">学习步骤 {module.steps.findIndex((item) => item.id === step.id) + 1}</span>
            <h1>{step.title}</h1>
            <p>最后修改 {this.formatDate(this.project.lastSavedAt)} · 修订号 {this.project.revision}</p>
          </div>
          <div class="title-actions">
            <ion-button fill="clear" class="studio-button" onClick={() => this.moveStep(-1)} title="Alt + ↑">上移</ion-button>
            <ion-button fill="clear" class="studio-button" onClick={() => this.moveStep(1)} title="Alt + ↓">下移</ion-button>
            <ion-button fill="outline" class="studio-button" onClick={() => this.duplicateStep()}>复制</ion-button>
            <ion-button fill="outline" color="danger" class="studio-button" onClick={() => this.deleteStep(step.id)}>删除</ion-button>
          </div>
        </div>

        {frozen && (
          <div class="frozen-callout">
            <div><strong>此版本已冻结</strong><span>字段已锁定，仍可预览和运行检查。</span></div>
            <ion-button size="small" class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
          </div>
        )}

        {this.renderShootBanner(step, frozen)}

        <section class="form-card">
          <div class="section-title"><span>01</span><div><h2>基础设计</h2><p>标题、类型、难度和预计时长</p></div></div>
          <div class="form-grid two">
            <ion-input disabled={frozen} label="步骤标题" labelPlacement="stacked" class="studio-input" value={step.title} onIonInput={(event) => this.updateStep({ title: event.detail.value ?? '' })} />
            <ion-select disabled={frozen} label="步骤类型" labelPlacement="stacked" class="studio-input" value={step.kind} onIonChange={(event) => this.updateStep({ kind: event.detail.value as LessonStep['kind'] })}>
              <ion-select-option value="示范">示范</ion-select-option>
              <ion-select-option value="讲解">讲解</ion-select-option>
              <ion-select-option value="练习">练习</ion-select-option>
            </ion-select>
            <ion-select disabled={frozen} label="难度标签" labelPlacement="stacked" class="studio-input" value={step.difficulty} onIonChange={(event) => this.updateStep({ difficulty: event.detail.value as Difficulty })}>
              {(['入门', '进阶', '挑战'] as Difficulty[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} type="number" min="10" max="600" label="预计时长（秒）" labelPlacement="stacked" class="studio-input" value={String(step.duration)} onIonInput={(event) => this.updateStep({ duration: Number(event.detail.value) || 0 })} />
          </div>
        </section>

        <section class="form-card">
          <div class="section-title"><span>02</span><div><h2>示范片段与镜头</h2><p>记录素材标识、手形、镜头角度和动作区域</p></div></div>
          <div class="demo-row">
            <div class={`video-thumbnail zone-${step.gestureZone}`}>
              <span class="play-mark">▶</span>
              <strong>{step.kind}片段</strong>
              <small>{step.camera}</small>
            </div>
            <div class="demo-fields">
              <ion-input disabled={frozen} label="示范片段名称" labelPlacement="stacked" class="studio-input" value={step.demoTitle} onIonInput={(event) => this.updateStep({ demoTitle: event.detail.value ?? '' })} />
              <ion-input disabled={frozen} label="本地素材地址（可空）" labelPlacement="stacked" class="studio-input" value={step.demoUrl} placeholder="例如 assets/hello.mp4" onIonInput={(event) => this.updateStep({ demoUrl: event.detail.value ?? '' })} />
            </div>
          </div>
          <div class="form-grid two">
            <ion-select disabled={frozen || Boolean(step.materialId)} label={step.materialId ? '镜头角度（以拍摄组回传为准）' : '镜头角度'} labelPlacement="stacked" class="studio-input" value={step.camera} onIonChange={(event) => this.updateStep({ camera: event.detail.value as CameraAngle })}>
              {(['正面', '左侧 45°', '右侧 45°', '俯拍手部', '全身远景'] as CameraAngle[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-select disabled={frozen} label="主要手形区域" labelPlacement="stacked" class="studio-input" value={step.gestureZone} onIonChange={(event) => this.updateStep({ gestureZone: event.detail.value as GestureZone })}>
              {(['左侧', '中央', '右侧'] as GestureZone[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
          </div>
          <ion-textarea disabled={frozen} autoGrow label="手形说明" labelPlacement="stacked" class="studio-input" value={step.handshape} onIonInput={(event) => this.updateStep({ handshape: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>03</span><div><h2>字幕与无障碍</h2><p>检查字幕位置、动作遮挡与替代文本</p></div></div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="字幕位置" labelPlacement="stacked" class="studio-input" value={step.captionPosition} onIonChange={(event) => this.updateStep({ captionPosition: event.detail.value as CaptionPosition })}>
              {(['下方安全区', '上移 15%', '角标提示', '画面中央'] as CaptionPosition[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} label="替代文本状态" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText ? '已填写' : '缺失'} readonly />
          </div>
          <ion-textarea disabled={frozen} autoGrow label="步骤字幕" labelPlacement="stacked" class="studio-input" value={step.caption} onIonInput={(event) => this.updateStep({ caption: event.detail.value ?? '' })} />
          <ion-textarea disabled={frozen} autoGrow label="替代文本（必须描述动作与表情）" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText} onIonInput={(event) => this.updateStep({ altText: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>04</span><div><h2>学习依赖与练习</h2><p>前置步骤、常见错误、练习任务与反馈</p></div></div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="前置条件" labelPlacement="stacked" class="studio-input" value={step.prerequisiteId} onIonChange={(event) => this.updateStep({ prerequisiteId: event.detail.value ?? '' })}>
              <ion-select-option value="">无前置条件</ion-select-option>
              {prerequisites.map((item) => <ion-select-option value={item.id}>{item.title}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} label="检查点（秒，用逗号分隔）" labelPlacement="stacked" class="studio-input" value={step.cuePoints.join(', ')} onIonInput={(event) => this.updateStep({ cuePoints: (event.detail.value ?? '').split(/[,，\s]+/).map(Number).filter((value) => Number.isFinite(value)) })} />
          </div>
          <ion-textarea disabled={frozen} autoGrow label="常见错误（每行一条）" labelPlacement="stacked" class="studio-input" value={step.commonMistakes.join('\n')} onIonInput={(event) => this.updateStep({ commonMistakes: (event.detail.value ?? '').split('\n').filter(Boolean) })} />
          <div class="form-grid two">
            <ion-textarea disabled={frozen} autoGrow label="练习任务" labelPlacement="stacked" class="studio-input" value={step.exercise} onIonInput={(event) => this.updateStep({ exercise: event.detail.value ?? '' })} />
            <ion-textarea disabled={frozen} autoGrow label="练习反馈" labelPlacement="stacked" class="studio-input" value={step.exerciseFeedback} onIonInput={(event) => this.updateStep({ exerciseFeedback: event.detail.value ?? '' })} />
          </div>
        </section>
      </div>
    );
  }

  private renderPreview() {
    const step = this.currentStep;
    const progress = Math.round(this.playProgress * 100);
    return (
      <section class="preview-panel">
        <div class="preview-head">
          <div><span class="eyebrow">学习者预览</span><h2>设备与安全区检查</h2></div>
          <ion-segment value={this.previewSize} class="studio-segment" onIonChange={(event) => { this.previewSize = event.detail.value as PreviewSize; }}>
            <ion-segment-button value="phone">手机</ion-segment-button>
            <ion-segment-button value="tablet">平板</ion-segment-button>
          </ion-segment>
        </div>
        {step ? (
          <div class={`device-frame ${this.previewSize}`}>
            <div class="device-top"><span>{this.previewSize === 'phone' ? '9:16' : '4:3'}</span><span>{step.camera}</span></div>
            <div class={`preview-stage zone-${step.gestureZone} caption-${step.captionPosition.replace(/\s|%/g, '')} ${step.captionPosition === '画面中央' && step.gestureZone === '中央' ? 'overlap-warning' : ''}`}>
              <div class="stage-grid" />
              <div class="signer">
                <div class="head"><span class="face"><i /><i /></span></div>
                <div class="torso" />
                <div class="arm arm-left"><span class="hand" /></div>
                <div class="arm arm-right"><span class="hand" /></div>
              </div>
              <div class="gesture-marker" style={{ left: step.gestureZone === '左侧' ? '18%' : step.gestureZone === '右侧' ? '70%' : '43%' }} />
              <div class="caption-preview">{step.caption || '未填写字幕'}</div>
              {step.captionPosition === '角标提示' && <div class="corner-caption">{step.caption.slice(0, 18) || '角标提示'}</div>}
              <div class="safe-area"><span>字幕安全区</span></div>
            </div>
            <div class="player-controls">
              <button class="play-button" onClick={() => this.togglePlay()}>{this.playing ? 'Ⅱ' : '▶'}</button>
              <div class="player-timeline">
                <span style={{ width: `${progress}%` }} />
                {step.cuePoints.map((cue) => <i style={{ left: `${Math.min(100, (cue / Math.max(1, step.duration)) * 100)}%` }} title={`检查点 ${cue}s`} />)}
              </div>
              <span class="time-code">{String(Math.floor(this.playProgress * step.duration)).padStart(2, '0')} / {step.duration}s</span>
            </div>
            <div class="preview-meta">
              <div><strong>{step.kind}</strong><span>步骤类型</span></div>
              <div><strong>{step.difficulty}</strong><span>难度标签</span></div>
              <div><strong>{step.cuePoints.length}</strong><span>检查点</span></div>
            </div>
            <p class="preview-caption-text">{step.caption}</p>
          </div>
        ) : <div class="empty-preview">选择步骤后显示设备预览。</div>}
      </section>
    );
  }

  private renderChecks() {
    const errors = this.checks.filter((check) => check.severity === 'error');
    const warnings = this.checks.filter((check) => check.severity === 'warning');
    const info = this.checks.filter((check) => check.severity === 'info');
    return (
      <section class="checks-panel">
        <div class="checks-summary">
          <div class="check-stat danger"><strong>{errors.length}</strong><span>阻断问题</span></div>
          <div class="check-stat warning"><strong>{warnings.length}</strong><span>需注意</span></div>
          <div class="check-stat"><strong>{info.length}</strong><span>优化建议</span></div>
        </div>
        <div class="check-list">
          {this.checks.length === 0 && <div class="all-clear"><strong>✓ 未发现问题</strong><p>字幕遮挡、步骤跳级和替代文本检查均已通过。</p></div>}
          {this.checks.map((check) => (
            <button class={`check-item ${check.severity}`} onClick={() => {
              if (check.moduleId) this.selectModule(check.moduleId);
              if (check.stepId) this.selectStep(check.stepId);
              this.activePanel = 'editor';
            }}>
              <span class="check-severity">{check.severity === 'error' ? '!' : check.severity === 'warning' ? '△' : 'i'}</span>
              <span><strong>{check.title}</strong><small>{check.detail}</small></span>
              <span class="check-arrow">→</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  render() {
    const module = this.currentModule;
    const errors = this.checks.filter((check) => check.severity === 'error').length;
    return (
      <Host>
        <ion-app>
          <ion-header class="studio-header">
            <ion-toolbar>
              <ion-buttons slot="start"><div class="logo-mark">手</div><div class="app-title"><strong>SignCourse Studio</strong><span>手语课程编排工具</span></div></ion-buttons>
              <ion-buttons slot="end" class="header-actions">
                <ion-segment value={this.role} class="role-segment" onIonChange={(event) => this.switchRole(event.detail.value as StudioRole)}>
                  <ion-segment-button value="teacher">教师端</ion-segment-button>
                  <ion-segment-button value="crew">拍摄组端</ion-segment-button>
                </ion-segment>
                <button class={`connection-status ${this.offline ? 'offline' : ''}`} onClick={() => { this.offline = !this.offline; this.showToast(this.offline ? 'warning' : 'success', this.offline ? '已进入离线模拟，编辑继续保存在本机。' : '已恢复在线模拟，本地草稿保持同步。'); }}><span />{this.offline ? '离线编辑中（点击恢复）' : '本地自动保存（点击模拟离线）'}</button>
                <ion-button fill="clear" class="studio-button" disabled={this.past.length === 0} onClick={() => this.undo()}>撤销</ion-button>
                <ion-button fill="clear" class="studio-button" disabled={this.future.length === 0} onClick={() => this.redo()}>重做</ion-button>
                {this.role === 'teacher' && <ion-button fill="outline" class="studio-button" onClick={() => this.saveDraft()}>保存草稿</ion-button>}
                {this.role === 'teacher' && (this.project.status === 'review'
                  ? <ion-button color="success" class="studio-button" onClick={() => this.freezeVersion()}>冻结版本</ion-button>
                  : this.project.status === 'changes'
                    ? <ion-button color="warning" class="studio-button" onClick={() => this.submitForReview()}>重新提交</ion-button>
                    : this.project.status === 'frozen'
                      ? <ion-button class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
                      : <ion-button color="primary" class="studio-button" onClick={() => this.submitForReview()}>提交复核</ion-button>)}
              </ion-buttons>
            </ion-toolbar>
          </ion-header>

          <ion-content fullscreen>
            <div class="project-ribbon">
              <div class="project-heading">
                {this.renderStatusBadge()}
                <ion-input disabled={this.role === 'crew'} value={this.project.title} class="project-title-input" onIonInput={(event) => { this.project = { ...this.project, title: event.detail.value ?? '' }; this.persist(); }} />
                <span>{this.project.teacher} · {this.project.audience}</span>
              </div>
              <div class="project-metrics">
                <div><strong>{this.project.modules.length}</strong><span>模块</span></div>
                <div><strong>{this.project.modules.reduce((sum, item) => sum + item.steps.length, 0)}</strong><span>步骤</span></div>
                <div><strong>{Math.ceil(this.project.modules.reduce((sum, item) => sum + item.steps.reduce((total, lesson) => total + lesson.duration, 0), 0) / 60)}</strong><span>分钟</span></div>
                <div class={errors ? 'has-errors' : ''}><strong>{errors}</strong><span>阻断问题</span></div>
              </div>
              <div class="workflow-actions">
                {this.role === 'teacher' && this.project.status === 'review' && <ion-button fill="clear" color="danger" class="studio-button" onClick={() => this.returnForChanges()}>退回修改</ion-button>}
                {this.role === 'teacher' && this.project.status === 'draft' && <ion-button fill="clear" class="studio-button" onClick={() => this.addModule()}>＋ 新建模块</ion-button>}
                {this.role === 'teacher' && <ion-button fill="clear" class="studio-button" onClick={() => this.addStep('练习')}>＋ 练习步骤</ion-button>}
              </div>
            </div>

            <main class={`studio-workspace ${this.role === 'crew' ? 'crew-workspace' : ''}`}>
              <aside class="course-panel">
                <div class="panel-heading"><div><span class="eyebrow">课程结构</span><h2>模块与步骤</h2></div>{this.role === 'teacher' && <button class="add-step-button" onClick={() => this.addStep('示范')}>＋</button>}</div>
                <div class="module-list">
                  {this.project.modules.map((item) => (
                    <section class={`module-card ${item.id === module?.id ? 'active' : ''}`} key={item.id}>
                      <button class="module-head" onClick={() => this.selectModule(item.id)}>
                        <span class="module-color" style={{ background: item.color }} />
                        <span><strong>{item.title}</strong><small>{item.steps.length} 个学习步骤</small></span>
                      </button>
                      {item.id === module?.id && <div class="step-list">{item.steps.map((lesson, index) => this.renderStepListItem(lesson, index))}</div>}
                    </section>
                  ))}
                </div>
                {this.role === 'teacher' && <div class="module-editor">
                  <ion-input disabled={this.project.status === 'frozen'} label="当前模块标题" labelPlacement="stacked" class="studio-input" value={module?.title ?? ''} onIonInput={(event) => this.updateCurrentModule({ title: event.detail.value ?? '' })} />
                  <ion-textarea disabled={this.project.status === 'frozen'} autoGrow label="模块目标" labelPlacement="stacked" class="studio-input" value={module?.summary ?? ''} onIonInput={(event) => this.updateCurrentModule({ summary: event.detail.value ?? '' })} />
                </div>}
                {this.role === 'crew' && <div class="module-editor crew-readonly-hint">拍摄组只读课程结构，学习步骤与字幕由教师维护。</div>}
              </aside>

              {this.role === 'crew' ? (
                <section class="editor-panel crew-panel">
                  <div class="panel-switcher">
                    <button class="active">拍摄任务与素材回传</button>
                  </div>
                  <div class="editor-scroll">{this.renderCrewBoard()}</div>
                </section>
              ) : <section class="editor-panel">
                <div class="panel-switcher">
                  <button class={this.activePanel === 'editor' ? 'active' : ''} onClick={() => { this.activePanel = 'editor'; }}>步骤编排</button>
                  <button class={this.activePanel === 'checks' ? 'active' : ''} onClick={() => { this.activePanel = 'checks'; }}>发布前检查 <span>{this.checks.length}</span></button>
                </div>
                <div class="editor-scroll">{this.activePanel === 'editor' ? this.renderStepEditor() : this.renderChecks()}</div>
              </section>}

              {this.role === 'teacher' && this.renderPreview()}
            </main>
          </ion-content>
          <ion-toast isOpen={Boolean(this.toast)} message={this.toast?.message} color={this.toast?.color} duration={3200} onDidDismiss={() => { this.toast = undefined; }} />
        </ion-app>
      </Host>
    );
  }
}
