---
name: add-or-edit-view
description: Adds a new sub-view to DatabaseConsole.tsx or alters an existing one. Handles the four required insertion points — view function, route registration, nav item, and parent state wiring — without breaking the monolithic shell architecture.
---

# Skill: /add-or-edit-view

Adds a new route-linked view into `DatabaseConsole.tsx`, or modifies an existing one. Handles all four required touch points in the correct order and following the established patterns.

---

## Architecture context (read before acting)

`DatabaseConsole.tsx` is intentionally monolithic. Every sub-view is a plain function defined **after** the `DatabaseConsole` default export closes. This is by design — do not split views into separate files unless explicitly asked.

The four touch points for any view change are:

| # | Location | What changes |
|---|---|---|
| 1 | `navItems` array (line ~31) | New nav entry with icon and path |
| 2 | `DatabaseConsole` state block | New `useState` + refresh logic if the view needs server data |
| 3 | `<Routes>` block (~line 687) | New `<Route>` wiring state/callbacks to the view |
| 4 | Bottom of file | The view function itself |

For **editing** an existing view, only touch points 3 and 4 are typically relevant.

---

## Pre-flight: gather inputs before touching any file

| Input | Question |
|---|---|
| **Add or edit?** | New view, or modifying an existing one? |
| **Route path** | What URL path? (e.g., `/analytics`) — must be unique in `navItems` |
| **Nav label & icon** | Label shown in sidebar; which `lucide-react` icon? |
| **Data needed** | Does this view need data from the API? Which `MemoryService` methods? |
| **New state required?** | If new data is needed, what state shape lives in `DatabaseConsole`? |
| **User actions** | Does the view trigger any mutations (POST/DELETE)? If so, does it need to call `refreshAll` afterward? |
| **Local UI state** | Does the view have its own local state (filters, pagination, expand/collapse)? |

---

## Step-by-step: adding a new view

### Step 1 — Add a nav entry

In the `navItems` array near the top of the file, add an entry. Import the icon from `lucide-react` in the existing import block at the top of the file.

```ts
// In the lucide-react import block
import { ..., MyIcon } from "lucide-react";

// In navItems
const navItems = [
  // ...existing items...
  { to: "/my-view", label: "My View", icon: MyIcon },
];
```

Nav order determines sidebar order — place it logically relative to existing items.

### Step 2 — Add state to `DatabaseConsole` (only if view needs server data)

Identify what data the view needs and where it fits in the existing state block (~line 352). Add only what is necessary.

```ts
// Inside DatabaseConsole(), with existing useState declarations
const [myData, setMyData] = useState<MyRecord[]>([]);
```

**If the data should refresh on every `refreshAll` call**, add it to the `Promise.all` inside `refreshAll`:

```ts
// Inside the Promise.all in refreshAll()
const [..., myDataResult] = await Promise.all([
  // ...existing calls...
  MemoryService.listMyRecords(),
]);
// ...
setMyData(myDataResult);
```

**If the view has its own pagination**, follow the `stmPage`/`ltmPage` pattern — add a page state variable and a dedicated refresh function:

```ts
const [myDataPage, setMyDataPage] = useState(1);

const refreshMyData = async (page: number = myDataPage) => {
  try {
    const normalizedPage = Math.max(page, 1);
    const result = await MemoryService.listMyRecords(normalizedPage, MY_PAGE_SIZE);
    setMyData(result);
    setMyDataPage(normalizedPage);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to load my data");
  }
};
```

Add the page size constant with the existing constants near the top:
```ts
const MY_PAGE_SIZE = 20;
```

### Step 3 — Register the route

Add a `<Route>` inside the existing `<Routes>` block. Pass only the state and callbacks the view actually needs as props.

```tsx
<Route
  path="/my-view"
  element={
    <MyView
      data={myData}
      page={myDataPage}
      pageSize={MY_PAGE_SIZE}
      refreshMyData={refreshMyData}
    />
  }
/>
```

For views with no server data (pure UI):
```tsx
<Route path="/my-view" element={<MyView />} />
```

For views that need the global `refreshAll` (e.g., after a mutation):
```tsx
<Route path="/my-view" element={<MyView onMutate={refreshAll} />} />
```

### Step 4 — Write the view function

Define the function **after** the last closing brace of `DatabaseConsole()`, alongside the other view functions at the bottom of the file. Follow the destructured inline-type signature pattern:

```tsx
function MyView({
  data,
  page,
  pageSize,
  refreshMyData,
}: {
  data: MyRecord[];
  page: number;
  pageSize: number;
  refreshMyData: (page?: number) => Promise<void>;
}) {
  // Local UI state only — no MemoryService calls here
  const [filterQuery, setFilterQuery] = useState("");

  return (
    <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
      <CardHeader>
        <CardTitle>My View Title</CardTitle>
        <CardDescription className="text-neutral-400">Describe what this view shows.</CardDescription>
      </CardHeader>
      <CardContent>
        {/* content */}
      </CardContent>
    </Card>
  );
}
```

---

## Step-by-step: editing an existing view

1. Read the current view function body at the bottom of `DatabaseConsole.tsx`
2. Identify the prop interface in the function signature — if new data is needed, add a prop and wire it at the `<Route>` (Step 3 above) and state block (Step 2 above)
3. Edit only the view function and any strictly necessary parent wiring
4. Do not reformat, rename, or restructure code outside the targeted edit area

---

## Styling reference

These patterns are used consistently across all views — do not deviate:

**Card container:**
```tsx
<Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
```

**List item row (hoverable):**
```tsx
<div className="rounded-[16px] border border-white/10 bg-neutral-900/50 p-4 transition-colors hover:border-white/16 hover:bg-neutral-950/72">
```

**Clickable row (button):**
```tsx
<button
  type="button"
  className="w-full rounded-[14px] border border-white/10 bg-neutral-950/40 p-3 text-left transition-all duration-150 hover:border-zinc-300/35 hover:bg-neutral-950/72 active:scale-[0.995]"
>
```

**Empty state:**
```tsx
<div className="rounded-[16px] border border-dashed border-white/10 bg-neutral-950/30 px-4 py-10 text-center text-sm text-neutral-400">
  Nothing here yet.
</div>
```

**Status badge classes** (reuse existing helpers):
- Use `getDocumentStatusBadgeClass(status)` for job/document status badges
- Generic badge: `<Badge className="bg-white/10 text-neutral-100">`
- Success: `bg-emerald-300/90 text-emerald-950`
- Error: `bg-rose-300/90 text-rose-950`

**Section label (uppercase tracking):**
```tsx
<p className="text-xs uppercase tracking-[0.22em] text-neutral-500">Section Label</p>
```

**Two-column grid (standard layout):**
```tsx
<div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
```

**Pagination** — use the existing `PaginationControls` component already defined in the file:
```tsx
<PaginationControls
  page={page}
  pageSize={pageSize}
  total={data.total}
  itemLabel="my items"
  onPageChange={(nextPage) => refreshMyData(nextPage)}
/>
```

**Scrollable list area:**
```tsx
<ScrollArea className="h-[420px] rounded-[16px] border border-white/10 bg-neutral-900/50 p-4">
```

---

## User action pattern (mutations inside a view)

If the view triggers a mutation (e.g., a delete or create) and must refresh global state afterward, it receives `onMutate: () => Promise<void>` as a prop (which is `refreshAll` from the parent). Wrap with `startTransition` only if you have access to it from the parent — otherwise a direct async call is fine within the view.

The toast pattern for user feedback:
```ts
toast.success("Action completed");
toast.error(error instanceof Error ? error.message : "Action failed");
```

---

## Icons

All icons come from `lucide-react`. Add new icon imports to the existing destructured import at line 2 of the file. Do not create separate import statements.

Currently imported icons (as of last read): `Activity`, `AlertTriangle`, `ArrowUpRight`, `ChevronDown`, `Database`, `FileStack`, `GitBranch`, `HardDriveUpload`, `CheckCircle2`, `LoaderCircle`, `Orbit`, `RefreshCw`, `ServerCog`, `Sparkles`.

---

## Completion checklist

- [ ] New icon imported in the `lucide-react` import block (if needed)
- [ ] `navItems` entry added with correct `to`, `label`, `icon` (new views only)
- [ ] `useState` added to `DatabaseConsole` for any new server data
- [ ] New data fetched inside `refreshAll`'s `Promise.all` (if applicable)
- [ ] Dedicated `refresh<Domain>` function added if view has its own pagination
- [ ] `<Route>` registered in the `<Routes>` block with correct props
- [ ] View function defined after `DatabaseConsole` closes, before `formatBytes`
- [ ] View function uses inline destructured props type (not a named interface)
- [ ] No `MemoryService` calls inside the view function — all data via props
- [ ] Empty state handled with dashed-border pattern
- [ ] Pagination wired through `PaginationControls` if view has paginated data
- [ ] `toast.error` used for all async failure paths
