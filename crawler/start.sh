#!/bin/bash
#xvfb-run --server-args="-screen 0 1600x900x24"
node gen/crawler-cli.js "$@" --crawl_list "./crawlList.txt" --output_dir "./output_dir/" --name "test" --pg_conf_file "./pg_login.json" --scrape_ads --click_ads=clickAndScrapeLandingPage
# for the click_ads parameter, not sure what we want yet
