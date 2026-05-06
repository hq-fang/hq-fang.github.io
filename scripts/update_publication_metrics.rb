#!/usr/bin/env ruby

require "date"
require "json"
require "net/http"
require "uri"
require "yaml"

ROOT = File.expand_path("..", __dir__)
PUBLICATION_GLOB = File.join(ROOT, "_data", "publications", "*.yml")
CONFIG_PATH = File.join(ROOT, "_config.yml")
USER_AGENT = "hq-fang-publication-metrics-updater"
REQUEST_DELAY_SECONDS = 1
SERPAPI_PAGE_SIZE = 100

GOOGLE_SCHOLAR_PROVIDERS = %w[googlescholar google_scholar].freeze

def load_yaml(path, permitted_classes: [])
  YAML.safe_load(File.read(path), permitted_classes: permitted_classes, aliases: true) || {}
end

def load_publication(path)
  load_yaml(path, permitted_classes: [Date])
end

def load_site_config
  load_yaml(CONFIG_PATH)
end

def fetch_json(url, headers: {}, max_attempts: 3, log_url: nil)
  uri = URI(url)
  request_label = log_url || url
  (1..max_attempts).each do |attempt|
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == "https"
    http.open_timeout = 10
    http.read_timeout = 20

    begin
      request = Net::HTTP::Get.new(uri)
      headers.each do |key, value|
        request[key] = value if value && !value.empty?
      end

      response = http.request(request)
      return JSON.parse(response.body) if response.is_a?(Net::HTTPSuccess)

      warn "Request failed for #{request_label}: HTTP #{response.code}"
      if response.code.to_i == 429 && attempt < max_attempts
        retry_after = response["retry-after"].to_i
        wait_seconds = [retry_after, attempt * 5].max
        sleep(wait_seconds)
        next
      end
    rescue StandardError => error
      warn "Request failed for #{request_label}: #{error.class}: #{error.message}"
    end

    sleep(attempt * 2) if attempt < max_attempts
  end

  nil
end

def google_scholar_author_id(site_config)
  scholar_url = site_config.dig("author", "googlescholar")
  return nil unless scholar_url

  uri = URI.parse(scholar_url)
  params = URI.decode_www_form(uri.query || "").to_h
  params["user"]
rescue URI::InvalidURIError
  nil
end

def build_serpapi_url(params)
  uri = URI("https://serpapi.com/search.json")
  uri.query = URI.encode_www_form(params)
  uri.to_s
end

def fetch_google_scholar_articles(site_config)
  api_key = ENV["SERPAPI_API_KEY"]
  unless api_key && !api_key.empty?
    warn "SERPAPI_API_KEY is not set; skipping Google Scholar citation updates."
    return nil
  end

  author_id = google_scholar_author_id(site_config)
  unless author_id && !author_id.empty?
    warn "Could not determine Google Scholar author ID from _config.yml; skipping Google Scholar citation updates."
    return nil
  end

  articles = []
  params = {
    "engine" => "google_scholar_author",
    "author_id" => author_id,
    "hl" => "en",
    "num" => SERPAPI_PAGE_SIZE,
    "api_key" => api_key
  }
  next_url = build_serpapi_url(params)
  next_log_url = build_serpapi_url(params.merge("api_key" => "[REDACTED]"))

  while next_url
    payload = fetch_json(
      next_url,
      headers: { "User-Agent" => USER_AGENT },
      log_url: next_log_url
    )
    return nil unless payload

    page_articles = payload["articles"] || []
    articles.concat(page_articles)

    next_url = payload.dig("serpapi_pagination", "next")
    next_log_url = next_url&.gsub(api_key, "[REDACTED]")
    sleep(REQUEST_DELAY_SECONDS)
  end

  articles
end

def normalize_title(value)
  value.to_s.downcase.gsub(/[^a-z0-9]+/, " ").strip
end

def build_google_scholar_article_index(site_config)
  articles = fetch_google_scholar_articles(site_config)
  return nil unless articles

  by_id = {}
  by_title = Hash.new { |hash, key| hash[key] = [] }

  articles.each do |article|
    citation_id = article["citation_id"]
    by_id[citation_id] = article if citation_id && !citation_id.empty?

    title_key = normalize_title(article["title"])
    next if title_key.empty?

    by_title[title_key] << article
  end

  { by_id: by_id, by_title: by_title }
end

def fetch_google_scholar_citation_count(publication, google_scholar_index)
  return nil unless google_scholar_index

  citation = publication["citation"] || {}
  google_scholar_id = citation["google_scholar_id"]

  if google_scholar_id && !google_scholar_id.empty?
    article = google_scholar_index[:by_id][google_scholar_id]
    unless article
      warn "Could not find Google Scholar article #{google_scholar_id} for #{publication['title']}."
      return nil
    end

    return article.dig("cited_by", "value") || 0
  end

  title_key = normalize_title(publication["title"])
  matches = google_scholar_index[:by_title][title_key]

  case matches.length
  when 1
    matches.first.dig("cited_by", "value") || 0
  when 0
    warn "Could not match Google Scholar article for #{publication['title']} by title."
    nil
  else
    warn "Found multiple Google Scholar matches for #{publication['title']}; add citation.google_scholar_id to disambiguate."
    nil
  end
end

def fetch_citation_count(publication, google_scholar_index: nil)
  citation = publication["citation"] || {}
  provider = citation["provider"]

  if provider == "semanticscholar"
    return nil unless citation["id"]

    encoded_id = URI.encode_www_form_component(citation["id"])
    url = "https://api.semanticscholar.org/graph/v1/paper/#{encoded_id}?fields=citationCount"
    headers = { "User-Agent" => USER_AGENT }
    api_key = ENV["SEMANTIC_SCHOLAR_API_KEY"]
    headers["x-api-key"] = api_key if api_key && !api_key.empty?
    payload = fetch_json(url, headers: headers)

    return payload && payload["citationCount"]
  end

  return fetch_google_scholar_citation_count(publication, google_scholar_index) if GOOGLE_SCHOLAR_PROVIDERS.include?(provider)

  nil
end

def github_repo_from_url(url)
  return nil unless url.is_a?(String) && !url.empty?

  uri = URI.parse(url)
  return nil unless %w[github.com www.github.com].include?(uri.host)

  segments = uri.path.split("/").reject(&:empty?)
  return nil if segments.length < 2

  owner = segments[0]
  repo = segments[1].sub(/\.git\z/, "")
  return nil if owner.empty? || repo.empty?

  "#{owner}/#{repo}"
rescue URI::InvalidURIError
  nil
end

def github_repo_for_link(link)
  return nil unless link.is_a?(Hash) && link["kind"] == "code"

  explicit_repo = link["github_repo"]
  if explicit_repo.is_a?(String) && !explicit_repo.strip.empty?
    return explicit_repo.strip
  end

  github_repo_from_url(link["url"])
end

def github_repos_for(publication)
  repos = []

  Array(publication["links"]).each do |link|
    repo = github_repo_for_link(link)
    repos << repo if repo
  end

  repos
    .compact
    .map { |repo| repo.to_s.strip }
    .reject(&:empty?)
    .uniq
end

def fetch_github_repo_star_counts(publication)
  repos = github_repos_for(publication)
  return {} if repos.empty?

  headers = {
    "Accept" => "application/vnd.github+json",
    "User-Agent" => USER_AGENT
  }
  token = ENV["GITHUB_TOKEN"] || ENV["GH_TOKEN"]
  headers["Authorization"] = "Bearer #{token}" if token && !token.empty?

  repos.each_with_object({}) do |repo, star_counts|
    payload = fetch_json("https://api.github.com/repos/#{repo}", headers: headers)
    star_count = payload && payload["stargazers_count"]
    star_counts[repo] = star_count unless star_count.nil?
  end
end

def extract_yaml_scalar(line, key)
  match = line.match(/^\s*#{Regexp.escape(key)}:\s*(.*?)\s*$/)
  return nil unless match

  value = match[1]
  if (value.start_with?("'") && value.end_with?("'")) || (value.start_with?('"') && value.end_with?('"'))
    value = value[1..-2]
  end
  value
end

def update_link_integer_field(block_lines, field_name, value)
  field_line = "    #{field_name}: #{value}\n"
  updated_block = block_lines.dup
  field_index = updated_block.index { |line| line =~ /^\s{4}#{Regexp.escape(field_name)}:\s*/ }

  if field_index
    updated_block[field_index] = field_line
  else
    insert_after =
      updated_block.index { |line| line =~ /^\s{4}github_repo:\s*/ } ||
      updated_block.index { |line| line =~ /^\s{4}url:\s*/ } ||
      updated_block.index { |line| line =~ /^\s{4}kind:\s*/ }
    return [block_lines, false] unless insert_after

    updated_block.insert(insert_after + 1, field_line)
  end

  [updated_block, updated_block != block_lines]
end

def update_metric_link_block(block_lines, citation_count, repo_star_counts)
  link_hash = {}

  block_lines.each do |line|
    link_hash["kind"] = extract_yaml_scalar(line, "kind") if line =~ /^\s*kind:/
    link_hash["url"] = extract_yaml_scalar(line, "url") if line =~ /^\s*url:/
    link_hash["github_repo"] = extract_yaml_scalar(line, "github_repo") if line =~ /^\s*github_repo:/
  end

  if link_hash["kind"] == "paper" && !citation_count.nil?
    return update_link_integer_field(block_lines, "citations", citation_count)
  end

  repo = github_repo_for_link(link_hash)
  star_count = repo && repo_star_counts[repo]
  return [block_lines, false] if star_count.nil?

  update_link_integer_field(block_lines, "stars", star_count)
end

def replace_link_metric_fields(content, citation_count, repo_star_counts)
  lines = content.lines
  links_index = lines.index { |line| line =~ /^links:\s*$/ }
  return [content, false] unless links_index

  section_end = lines.length
  ((links_index + 1)...lines.length).each do |index|
    next if lines[index].strip.empty?

    if lines[index] =~ /^\S/
      section_end = index
      break
    end
  end

  updated = false
  rebuilt_lines = []
  rebuilt_lines.concat(lines[0..links_index])

  index = links_index + 1
  while index < section_end
    if lines[index] =~ /^\s{2}-\s/
      block_end = index + 1
      block_end += 1 while block_end < section_end && lines[block_end] !~ /^\s{2}-\s/
      updated_block, block_updated = update_metric_link_block(lines[index...block_end], citation_count, repo_star_counts)
      rebuilt_lines.concat(updated_block)
      updated ||= block_updated
      index = block_end
    else
      rebuilt_lines << lines[index]
      index += 1
    end
  end

  rebuilt_lines.concat(lines[section_end..-1]) if section_end < lines.length
  updated_content = rebuilt_lines.join
  [updated_content, updated && updated_content != content]
end

def remove_top_level_block(content, key)
  lines = content.lines
  start_index = lines.index { |line| line =~ /^#{Regexp.escape(key)}:\s*$/ }
  return [content, false] unless start_index

  end_index = lines.length
  ((start_index + 1)...lines.length).each do |index|
    next if lines[index].strip.empty?

    if lines[index] =~ /^\S/
      end_index = index
      break
    end
  end

  updated_lines = lines[0...start_index] + lines[end_index..-1].to_a
  [updated_lines.join, true]
end

def remove_top_level_scalar(content, key)
  updated_content = content.gsub(/^#{Regexp.escape(key)}:\s*.*(?:\n|\z)/, "")
  [updated_content, updated_content != content]
end

publication_entries = Dir.glob(PUBLICATION_GLOB).sort.map { |path| [path, load_publication(path)] }
needs_google_scholar = publication_entries.any? do |_path, publication|
  GOOGLE_SCHOLAR_PROVIDERS.include?(publication.dig("citation", "provider"))
end
google_scholar_index = needs_google_scholar ? build_google_scholar_article_index(load_site_config) : nil

changed_files = []

publication_entries.each do |path, publication|
  content = File.read(path)
  updated = false

  citation_count = fetch_citation_count(publication, google_scholar_index: google_scholar_index)
  citation_count = publication.dig("metrics", "citation_count") if citation_count.nil?

  sleep(REQUEST_DELAY_SECONDS)

  repo_star_counts = fetch_github_repo_star_counts(publication)
  content, field_updated = replace_link_metric_fields(content, citation_count, repo_star_counts)
  updated ||= field_updated

  content, field_updated = remove_top_level_block(content, "metrics")
  updated ||= field_updated

  content, field_updated = remove_top_level_scalar(content, "github_repo")
  updated ||= field_updated

  sleep(REQUEST_DELAY_SECONDS)

  next unless updated

  File.write(path, content)
  changed_files << File.basename(path)
  puts "Updated #{File.basename(path)}"
end

if changed_files.empty?
  puts "No publication metric changes found."
else
  puts "Changed files: #{changed_files.join(', ')}"
end
