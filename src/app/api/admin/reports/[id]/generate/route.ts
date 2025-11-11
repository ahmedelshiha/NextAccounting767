import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireTenantContext } from '@/lib/tenant-context'
import { hasPermission } from '@/lib/permissions'
import { rateLimit } from '@/lib/rate-limit'
import { generateReportHTML, applyFilters, calculateSummaryStats } from '@/app/admin/users/utils/report-builder'

/**
 * POST /api/admin/reports/[id]/generate
 * Generate a report in the specified format
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  return requireTenantContext(request, async (context) => {
    try {
      // Rate limiting
      const identifier = request.headers.get('x-forwarded-for') || 'anonymous'
      const { success } = await rateLimit(identifier)
      if (!success) {
        return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
      }

      // Permission check
      const hasAccess = await hasPermission(context.userId, 'admin:reports:generate')
      if (!hasAccess) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }

      // Fetch report
      const report = await prisma.report.findUnique({
        where: { id: params.id }
      })

      if (!report) {
        return NextResponse.json({ error: 'Report not found' }, { status: 404 })
      }

      // Parse request body
      const body = await request.json()
      const { format = 'pdf', filters } = body

      // Validate format
      if (!['pdf', 'xlsx', 'csv', 'json'].includes(format)) {
        return NextResponse.json(
          { error: 'Invalid export format. Supported: pdf, xlsx, csv, json' },
          { status: 400 }
        )
      }

      // Create execution record
      const execution = await prisma.reportExecution.create({
        data: {
          id: crypto.getRandomUUID(),
          reportId: report.id,
          status: 'generating',
          executedAt: new Date()
        }
      })

      try {
        // Fetch users data for report
        const users = await prisma.user.findMany({
          where: {
            tenantId: report.tenantId
          },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
            availabilityStatus: true,
            department: true,
            position: true,
            createdAt: true,
            lastLoginAt: true
          }
        })

        // Prepare report data
        let data = users

        // Apply filters from request if provided
        if (filters) {
          data = applyFilters(data, filters)
        }

        // Build report data structure
        const reportData = {
          columns: report.sections[0]?.columns || [],
          rows: data,
          rowCount: data.length,
          summary: calculateSummaryStats(data, report.sections[0]?.calculations || [])
        }

        let generatedContent = ''
        let contentType = 'text/html'
        let filename = `${report.name.replace(/\s+/g, '-')}-${Date.now()}`

        // Generate report based on format
        switch (format) {
          case 'pdf':
            generatedContent = generateReportHTML(report, reportData)
            contentType = 'text/html'
            filename += '.html'
            break

          case 'xlsx':
            generatedContent = generateExcelReport(report, reportData)
            contentType = 'text/tab-separated-values'
            filename += '.xlsx'
            break

          case 'csv':
            generatedContent = generateCSVReport(report, reportData)
            contentType = 'text/csv'
            filename += '.csv'
            break

          case 'json':
            generatedContent = JSON.stringify(reportData, null, 2)
            contentType = 'application/json'
            filename += '.json'
            break
        }

        // Update execution record
        await prisma.reportExecution.update({
          where: { id: execution.id },
          data: {
            status: 'completed',
            fileSizeBytes: Buffer.byteLength(generatedContent),
            completedAt: new Date()
          }
        })

        // Update report generation count
        await prisma.report.update({
          where: { id: report.id },
          data: {
            lastGeneratedAt: new Date(),
            generationCount: { increment: 1 }
          }
        })

        // Return response
        return new NextResponse(generatedContent, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${filename}"`
          }
        })
      } catch (error) {
        // Update execution with error
        await prisma.reportExecution.update({
          where: { id: execution.id },
          data: {
            status: 'failed',
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
            completedAt: new Date()
          }
        })

        throw error
      }
    } catch (error) {
      console.error('Failed to generate report:', error)
      return NextResponse.json(
        { error: 'Failed to generate report' },
        { status: 500 }
      )
    }
  })
}

/**
 * Generate Excel-compatible report
 */
function generateExcelReport(report: any, reportData: any): string {
  let tsv = ''

  // Add title
  tsv += `${report.name}\n`
  if (report.description) {
    tsv += `${report.description}\n`
  }
  tsv += `Generated: ${new Date().toLocaleDateString()}\n\n`

  // Add summary if available
  if (reportData.summary && Object.keys(reportData.summary).length > 0) {
    tsv += 'SUMMARY\n'
    Object.entries(reportData.summary).forEach(([key, value]) => {
      tsv += `${key.replace(/_/g, ' ')}\t${value}\n`
    })
    tsv += '\n\n'
  }

  // Add data table
  if (reportData.rows && reportData.rows.length > 0) {
    const columns = reportData.columns || [
      { name: 'name', label: 'Name' },
      { name: 'email', label: 'Email' },
      { name: 'role', label: 'Role' },
      { name: 'availabilityStatus', label: 'Status' }
    ]

    tsv += columns.map(c => c.label).join('\t') + '\n'
    reportData.rows.forEach((row: any) => {
      tsv += columns.map(c => row[c.name] || '').join('\t') + '\n'
    })
  }

  return tsv
}

/**
 * Generate CSV report
 */
function generateCSVReport(report: any, reportData: any): string {
  let csv = ''

  // Add headers
  if (reportData.columns && reportData.columns.length > 0) {
    csv += reportData.columns.map((c: any) => `"${c.label}"`).join(',') + '\n'
  }

  // Add data
  if (reportData.rows && reportData.rows.length > 0) {
    const columns = reportData.columns || []
    reportData.rows.forEach((row: any) => {
      const values = columns.map((c: any) => {
        const value = row[c.name] || ''
        return `"${String(value).replace(/"/g, '""')}"`
      })
      csv += values.join(',') + '\n'
    })
  }

  return csv
}
