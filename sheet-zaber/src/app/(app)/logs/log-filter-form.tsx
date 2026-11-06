import { Button, PillLink } from "@/components/ui/button"
import { SelectField, TextField } from "@/components/ui/field"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import {
  LOG_LIMIT_OPTIONS,
  LOG_METHOD_OPTIONS,
  LOG_STATUS_OPTIONS,
  logsHref,
  selectValue,
  type LogFilterValues,
} from "./filter-params"

/*
 * The filter bar is a plain GET <form>, so filtering is a navigation: the browser builds the query
 * string, the page reads it, and `listRequestLogs` does the WHERE clause server-side
 * (`src/server/db/queries/logs.ts:64`). No client state, no JS, nothing to fake, and every result is
 * a link you can paste to a colleague.
 *
 * `offset` is pinned to 0 in the submission: changing a filter is not page 3 of the old filter set.
 * `limit` rides along so the rows-per-page choice survives an apply.
 */

export function LogFilterForm({
  values,
  endpointOptions,
  endpointsReadable,
  activeFilters,
}: {
  values: LogFilterValues
  endpointOptions: Array<{ value: string; label: string }>
  /** `false` = `listApis` failed, so the endpoint filter cannot be offered honestly. */
  endpointsReadable: boolean
  activeFilters: number
}) {
  return (
    <Panel as="section">
      <PanelHeader
        title="Filters"
        description="Applied by the query itself, not after the fact in the browser. Empty date bounds mean unbounded on that side."
        action={
          activeFilters > 0 ? (
            <PillLink href={logsHref(values, { status: "all", apiId: "", method: "", from: "", to: "", offset: 0 })} variant="ghost" size="sm">
              Clear {activeFilters} filter{activeFilters === 1 ? "" : "s"}
            </PillLink>
          ) : undefined
        }
      />
      <PanelBody>
        <form method="get" action="/logs" className="flex flex-col gap-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <SelectField
              label="Result"
              name="status"
              options={LOG_STATUS_OPTIONS}
              defaultValue={selectValue(values.status, ["all", "success", "failed"])}
              hint="success is a status code below 400; failed is 400 and up."
            />

            {endpointsReadable ? (
              <SelectField
                label="Endpoint"
                name="apiId"
                placeholder="All endpoints"
                options={endpointOptions}
                defaultValue={
                  values.apiId !== "" && endpointOptions.some((o) => o.value === values.apiId)
                    ? values.apiId
                    : ""
                }
                hint={
                  endpointOptions.length === 0
                    ? "You own no endpoints, so there is nothing to filter by."
                    : "Narrows the table to the rows logged against one endpoint."
                }
              />
            ) : (
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-[14px] text-mist">Endpoint</span>
                <p className="text-[13px] leading-[1.6] text-dust">
                  Your endpoint list could not be read, so the picker is not shown. The rest of the
                  filters still work.
                </p>
              </div>
            )}

            <SelectField
              label="Method"
              name="method"
              placeholder="Any method"
              options={LOG_METHOD_OPTIONS}
              defaultValue={selectValue(values.method, LOG_METHOD_OPTIONS.map((o) => o.value))}
              hint="Matches the verb recorded on the row."
            />

            <TextField
              label="From date (inclusive)"
              name="from"
              type="date"
              defaultValue={values.from}
              hint="No requests before this day. Empty means no lower bound."
            />

            <TextField
              label="To date (through the end of that day)"
              name="to"
              type="date"
              defaultValue={values.to}
              hint="The query bound is exclusive, so the page you pick is fully included."
            />

            <SelectField
              label="Rows per page"
              name="limit"
              options={LOG_LIMIT_OPTIONS}
              defaultValue={selectValue(String(values.limit), LOG_LIMIT_OPTIONS.map((o) => o.value))}
              hint="1 to 200 allowed by paginationSchema; this page offers 25 to 200."
            />
          </div>

          {/* Restart pagination on every apply; keep the chosen page size. */}
          <input type="hidden" name="offset" value="0" readOnly />

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="solid" size="md">
              Apply filters
            </Button>
            <PillLink href="/logs" variant="line" size="sm">
              Reset to everything
            </PillLink>
            <span className="folio">
              {activeFilters} {activeFilters === 1 ? "filter" : "filters"} active
            </span>
          </div>
        </form>
      </PanelBody>
    </Panel>
  )
}
