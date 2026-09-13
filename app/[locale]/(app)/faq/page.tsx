import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { FAQ_SECTIONS } from './config'

interface FaqPageProps {
  params: Promise<{ locale: string }>
}

export async function generateMetadata({ params }: FaqPageProps): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'faq' })

  return { title: `${t('title')} — Alea` }
}

export default async function FaqPage({ params }: FaqPageProps) {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'faq' })

  return (
    <div className="relative isolate overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-gradient-to-b from-primary/10 via-primary/5 to-transparent"
      />

      <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8 lg:py-20">
        <header className="max-w-3xl">
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.24em] text-primary">
            {t('eyebrow')}
          </p>
          <h1 className="text-balance text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            {t('title')}
          </h1>
          <p className="mt-5 max-w-2xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg">
            {t('subtitle')}
          </p>
          <p className="mt-6 inline-flex rounded-full border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
            {t('currentRules')}
          </p>
        </header>

        <div className="mt-12 space-y-12 sm:mt-16 sm:space-y-16">
          {FAQ_SECTIONS.map((section, sectionIndex) => (
            <section
              key={section.key}
              aria-labelledby={`faq-${section.key}`}
              className="grid gap-5 border-t border-border/70 pt-7 md:grid-cols-[minmax(0,0.75fr)_minmax(0,2fr)] md:gap-10"
            >
              <div>
                <div className="flex items-center gap-3">
                  <span aria-hidden="true" className="font-mono text-xs text-muted-foreground">
                    {String(sectionIndex + 1).padStart(2, '0')}
                  </span>
                  {'hasBadge' in section && section.hasBadge ? (
                    <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                      {t(`sections.${section.key}.badge`)}
                    </span>
                  ) : null}
                </div>
                <h2
                  id={`faq-${section.key}`}
                  className="mt-3 text-xl font-semibold tracking-tight text-foreground"
                >
                  {t(`sections.${section.key}.title`)}
                </h2>
              </div>

              <Accordion type="single" collapsible className="w-full">
                {section.items.map((item) => (
                  <AccordionItem
                    key={item}
                    value={`${section.key}-${item}`}
                    className="border-border/70 first:border-t"
                  >
                    <AccordionTrigger className="min-h-11 text-left text-base leading-6 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                      {t(`sections.${section.key}.items.${item}.question`)}
                    </AccordionTrigger>
                    <AccordionContent className="max-w-2xl pr-8 text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
                      {t(`sections.${section.key}.items.${item}.answer`)}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
